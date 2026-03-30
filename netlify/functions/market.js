const https = require('https');

const API_KEY = '55f461db120d4ce281312ee3018ea459';

const SYMBOLS = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  USDJPY: 'USD/JPY',
  USDCHF: 'USD/CHF',
  AUDUSD: 'AUD/USD',
};

function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const type   = event.queryStringParameters?.type   || 'prices';
  const pair   = event.queryStringParameters?.pair   || 'EURUSD';
  const tf     = event.queryStringParameters?.tf     || '1h';
  const count  = event.queryStringParameters?.count  || '60';

  try {
    // ── FETCH ALL PRICES ─────────────────────────────────
    if (type === 'prices') {
      const symStr = Object.values(SYMBOLS).map(encodeURIComponent).join('%2C');
      const url = `https://api.twelvedata.com/price?symbol=${symStr}&apikey=${API_KEY}`;
      const data = await fetchURL(url);

      const result = {};
      for (const [name, sym] of Object.entries(SYMBOLS)) {
        const entry = data[sym] || data;
        if (entry && entry.price) {
          result[name] = parseFloat(entry.price);
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, prices: result }) };
    }

    // ── FETCH OHLC CANDLES ────────────────────────────────
    if (type === 'candles') {
      const sym = SYMBOLS[pair];
      if (!sym) return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown pair' }) };

      const tfMap = { M1:'1min', M5:'5min', M15:'15min', H1:'1h', H4:'4h', D1:'1day' };
      const interval = tfMap[tf] || '1h';
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${count}&apikey=${API_KEY}`;
      const data = await fetchURL(url);

      if (!data || !data.values) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: data?.message || 'No data', raw: data }) };
      }

      // Reverse: API returns newest first, we want oldest first
      const candles = data.values.slice().reverse().map(v => ({
        t: v.datetime,
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, pair, tf, candles }) };
    }

    // ── FETCH D1 FOR CRT ANALYSIS ─────────────────────────
    if (type === 'd1') {
      const sym = SYMBOLS[pair];
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=10&apikey=${API_KEY}`;
      const data = await fetchURL(url);

      if (!data || !data.values || data.values.length < 4) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, error: 'Not enough D1 data' }) };
      }

      const candles = data.values.slice().reverse().map(v => ({
        t: v.datetime,
        o: parseFloat(v.open),
        h: parseFloat(v.high),
        l: parseFloat(v.low),
        c: parseFloat(v.close),
      }));

      // Run CRT detection server-side
      const len = candles.length;
      const rangeC  = candles[len - 4];
      const sweepC  = candles[len - 3];
      const distC   = candles[len - 2];

      const rHigh = rangeC.h, rLow = rangeC.l;
      const rRange = rHigh - rLow;
      const fib50  = rLow + rRange * 0.5;

      const sweepBodyTop    = Math.max(sweepC.o, sweepC.c);
      const sweepBodyBottom = Math.min(sweepC.o, sweepC.c);

      // Trend detection
      const recent = candles.slice(len - 5);
      const highs  = recent.map(c => c.h);
      const lows   = recent.map(c => c.l);
      const hh = highs[4] > highs[3] && highs[3] > highs[2];
      const hl = lows[4]  > lows[3]  && lows[3]  > lows[2];
      const ll = lows[4]  < lows[3]  && lows[3]  < lows[2];
      const lh = highs[4] < highs[3] && highs[3] < highs[2];
      const trend = (hh && hl) ? 'bullish' : (ll && lh) ? 'bearish' : 'neutral';

      const bullish = rangeC.c < rangeC.o && sweepC.l < rLow    && sweepBodyTop    < fib50 && sweepBodyBottom >= rLow  - rRange * 0.5;
      const bearish = rangeC.c > rangeC.o && sweepC.h > rHigh   && sweepBodyBottom > fib50 && sweepBodyTop    <= rHigh + rRange * 0.5;

      // Confidence score
      const sweepDepth = Math.abs(sweepC.h - sweepC.l) / rRange;
      const bodyRatio  = Math.abs(sweepC.c - sweepC.o) / (Math.abs(sweepC.h - sweepC.l) || 1);
      const conf = Math.min(95, Math.round(50 + sweepDepth * 30 + bodyRatio * 15));

      let signal = 'NONE';
      if      (bullish && trend === 'bullish') signal = 'BUY';
      else if (bearish && trend === 'bearish') signal = 'SELL';
      else if (bullish || bearish)             signal = 'WAIT';

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          pair,
          signal,
          trend,
          conf,
          crtHigh:  rHigh,
          crtLow:   rLow,
          fib50,
          rangeCandle:  rangeC,
          sweepCandle:  sweepC,
          distCandle:   distC,
          candles,
        }),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Unknown type' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
