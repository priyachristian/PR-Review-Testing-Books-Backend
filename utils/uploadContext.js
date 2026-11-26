const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const mongoose = require('mongoose');

const storage = new AsyncLocalStorage();

/**
 * Per-call context shared by every attempt of a wrapped create function.
 * - id: key of the Redis upload ledger for this call
 * - committed: true once any Mongo transaction committed inside this call
 * - uploaded: S3 urls uploaded during this call (in-memory fallback if Redis is down)
 */
const runWithUploadContext = fn =>
  storage.run({ id: crypto.randomUUID(), committed: false, uploaded: new Set() }, () => fn(storage.getStore()));

const getUploadContext = () => storage.getStore();

/**
 * Marks the current upload context as committed whenever a Mongo transaction commits inside it.
 * Needed because services keep running after commitTransaction (notifications, auto payment) and may still throw.
 * Without this signal a failure after the commit could delete files the saved document already references.
 */
const { ClientSession } = mongoose.mongo;
if (!ClientSession.prototype.commitTransaction.isUploadCommitTracked) {
  const originalCommit = ClientSession.prototype.commitTransaction;
  const trackedCommit = async function (...args) {
    const result = await originalCommit.apply(this, args);
    const context = storage.getStore();
    if (context) context.committed = true;
    return result;
  };
  trackedCommit.isUploadCommitTracked = true;
  ClientSession.prototype.commitTransaction = trackedCommit;
}

module.exports = { runWithUploadContext, getUploadContext };
