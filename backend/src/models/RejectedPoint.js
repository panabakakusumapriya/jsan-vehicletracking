const mongoose = require('mongoose');

/**
 * A GPS point the device sent that could not be stored as a LocationPoint.
 *
 * This exists so that "the device can stop re-sending it" and "the data is gone" are not the same
 * decision.
 *
 * The device only deletes a point from its local SQLite queue once the server ACKS it. A point the
 * server refuses forever therefore jams the head of the queue and gets re-uploaded on every cycle
 * — that is what put 25 GB of mobile data on a driver's phone in a month. So the server has to ack
 * it. But acking without keeping it would throw a real observation away, and the application is
 * live: a malformed timestamp is still evidence of where a vehicle was.
 *
 * So: keep the raw payload exactly as it arrived, verbatim, and ack. Nothing is lost, the queue
 * drains, and a bad point can be inspected — or repaired and replayed into LocationPoint — later.
 *
 * Deliberately NO TTL index. Every other transient collection here expires; this one does not,
 * because it holds the only surviving copy of data the device has already deleted.
 */
const rejectedPointSchema = new mongoose.Schema(
  {
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // The device's own id for this point — the same value it uses as its SQLite primary key.
    clientId: { type: String, default: null },
    clientTripId: { type: String, default: null },

    // Why LocationPoint would not take it — a validation message or a Mongo error string.
    reason: { type: String, required: true },

    // The point exactly as the device sent it. Mixed rather than a typed schema on purpose: the
    // whole reason it is here is that it did not fit the typed schema, so imposing one again
    // would drop the very fields that explain what went wrong.
    raw: { type: mongoose.Schema.Types.Mixed, required: true },

    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

/**
 * Same idempotency contract as LocationPoint: a device that re-sends before it processes the ack
 * must not create duplicates. Partial so points that arrived without a clientId are still kept
 * rather than colliding on null.
 */
rejectedPointSchema.index(
  { clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);
rejectedPointSchema.index({ driverId: 1, receivedAt: -1 });

module.exports = mongoose.model('RejectedPoint', rejectedPointSchema);
