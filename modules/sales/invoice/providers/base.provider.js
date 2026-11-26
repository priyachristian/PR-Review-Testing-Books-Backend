const { classifyError } = require('./errorClassifier');

class EInvoiceProvider {
  /** Provider name from THIRD_PARTY_PROVIDERS; used when classifying errors. */
  get providerName() {
    throw new Error('providerName not implemented');
  }

  async generateEInvoice(payload, context = {}) {
    return this.run(() => this.doGenerateEInvoice(payload, context));
  }

  async cancelEInvoice(payload, context = {}) {
    return this.run(() => this.doCancelEInvoice(payload, context));
  }

  async generateEWayBill(payload, context = {}) {
    return this.run(() => this.doGenerateEWayBill(payload, context));
  }

  async cancelEWayBill(payload, context = {}) {
    return this.run(() => this.doCancelEWayBill(payload, context));
  }

  async refetchEInvoice(payload, context = {}) {
    return this.run(() => this.doRefetchEInvoice(payload, context));
  }

  async verifyGSTIN(payload, context = {}) {
    return this.run(() => this.doVerifyGSTIN(payload, context));
  }

  /** Runs one operation, returning `{ success, data, providerRaw }` or throwing a classified ProviderError. */
  async run(operation) {
    try {
      const { data, providerRaw } = await operation();
      return { success: true, data, providerRaw };
    } catch (error) {
      throw classifyError(error, { providerName: this.providerName });
    }
  }

  async doGenerateEInvoice(_payload, _context) {
    throw new Error('doGenerateEInvoice not implemented');
  }

  async doCancelEInvoice(_payload, _context) {
    throw new Error('doCancelEInvoice not implemented');
  }

  async doGenerateEWayBill(_payload, _context) {
    throw new Error('doGenerateEWayBill not implemented');
  }

  async doCancelEWayBill(_payload, _context) {
    throw new Error('doCancelEWayBill not implemented');
  }

  async doRefetchEInvoice(_payload, _context) {
    throw new Error('doRefetchEInvoice not implemented');
  }

  async doVerifyGSTIN(_payload, _context) {
    throw new Error('doVerifyGSTIN not implemented');
  }
}

module.exports = { EInvoiceProvider };
