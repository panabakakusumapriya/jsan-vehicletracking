const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

/**
 * Send a JSON body gzipped, when the client says it can take it.
 *
 * This app has NO compression middleware — nothing in app.js compresses anything, and
 * `compression` is not even a dependency. That is survivable for the rest of the API, whose
 * responses are kilobytes. It is not survivable for the road payloads: one full area measures
 * ~2.5 MB of JSON on the phone, and the admin map's assigned-network layer is larger still. gzip
 * takes those to a fraction. Shipping them uncompressed would undo the whole reason the payload is
 * positional tuples instead of GeoJSON in the first place.
 *
 * Done here rather than by adding middleware in app.js because only a handful of routes are
 * megabytes large, and a blanket middleware would also start compressing the 10-second ingest
 * acks, where the CPU is pure loss.
 *
 * zlib.gzip and not gzipSync: 2.5 MB takes ~80 ms to compress, and gzipSync spends all of it on
 * the event loop, stalling every other request on this single-process API. The async form runs on
 * the threadpool.
 *
 * Cache-Control makes the response storable-but-revalidated, which lets Express's own ETag turn
 * the common case — the map reopens, coverage has not moved — into an empty 304 instead of a
 * second half-megabyte. `private` because the body describes one account's assigned network and
 * must never sit in a shared proxy cache.
 */
async function sendCompressed(req, res, body, tag = 'compressed-json') {
  const json = JSON.stringify(body);
  res.set('Cache-Control', 'private, no-cache');
  // Without Vary, a cache that stored the gzipped body could hand it to a client that never asked
  // for gzip and cannot decode it.
  res.set('Vary', 'Accept-Encoding');
  res.type('application/json');

  if (!req.acceptsEncodings('gzip')) return res.send(json);

  try {
    const packed = await gzip(json, { level: zlib.constants.Z_DEFAULT_COMPRESSION });
    res.set('Content-Encoding', 'gzip');
    return res.send(packed);
  } catch (err) {
    // Compression failing is not a reason to fail the request — the client still needs the map.
    // Logged rather than swallowed so a systematically failing zlib is visible instead of just
    // showing up as an unexplained bandwidth bill.
    console.error(`[${tag}] gzip failed, sending uncompressed:`, err.message);
    res.removeHeader('Content-Encoding');
    return res.send(json);
  }
}

module.exports = { sendCompressed };
