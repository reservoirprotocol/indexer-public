import { defaultAbiCoder } from "@ethersproject/abi";
import { AddressZero } from "@ethersproject/constants";

import { Builder } from "./builder.js";
import type { MintPhase, TxParam } from "./types.d";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normalizeValue = (value: any) => {
  if (typeof value === "number" && value > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return value;
};

export class Phase {
  phase: MintPhase;

  parent: Builder;

  globalMaxMintsPerWallet: number;
  globalMaxMintsPerTransaction: number;

  constructor(
    phase: MintPhase,
    globalMaxMintsPerWallet: number,
    globalMaxMintsPerTransaction: number,
    parent: Builder
  ) {
    this.phase = phase;
    this.globalMaxMintsPerWallet = globalMaxMintsPerWallet;
    this.globalMaxMintsPerTransaction = globalMaxMintsPerTransaction;
    this.parent = parent;
  }

  get startTime(): number {
    return this.phase.startTime as number;
  }

  get endTime(): number {
    return this.phase.endTime as number;
  }

  get maxMintsPerWallet(): number {
    return (
      normalizeValue(this.phase.maxMintsPerWallet ?? this.globalMaxMintsPerWallet) ?? undefined
    );
  }

  get maxMintPerTransaction(): number {
    return (
      normalizeValue(this.phase.maxMintsPerTransaction ?? this.globalMaxMintsPerTransaction) ??
      undefined
    );
  }

  get price(): string | null {
    if (this.phase.price == "0") {
      return null;
    } else {
      return this.phase.price as string;
    }
  }

  get currency(): string | null {
    return this.phase.currency ?? null;
  }

  hasRecipient() {
    return this.phase.tx.params?.find((p) => p.kind === "RECIPIENT");
  }

  hasQuantity() {
    return this.phase.tx.params?.find((p) => p.kind === "QUANTITY");
  }

  hasMappingRecipient() {
    return this.phase.tx.params?.find((p) => p.kind === "MAPPING_RECIPIENT");
  }

  maxMint() {
    return (
      this.phase.maxMintsPerTransaction ??
      this.phase.maxMintsPerWallet ??
      this.globalMaxMintsPerTransaction ??
      this.globalMaxMintsPerWallet
    );
  }

  getParams(): TxParam[] {
    // Return the params that are supposed to be filled by the consumer
    // MAPPING_RECIPIENT is automatically filled with the value from RECIPIENT
    return (
      this.phase.tx.params?.filter(
        (el) => el.value === undefined || el.kind == "MAPPING_RECIPIENT"
      ) ?? []
    );
  }

  // Build a transaction with the given params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildTransaction(inputs: Record<string, any>) {
    const recipientParam = this.hasRecipient();
    if (recipientParam) {
      if (!inputs[recipientParam.name]) {
        throw new Error("Recipient needs to be set");
      }
    }

    const quantityParam = this.hasQuantity();
    if (quantityParam) {
      const quantity = inputs[quantityParam.name];
      if (quantity === undefined) {
        throw new Error("Quantity needs to be set");
      } else {
        const max = this.maxMint();
        if (max !== 0) {
          if (quantity > max) {
            throw new Error("Quantity too high.");
          }
        }
      }
    }

    const mappingRecipient = this.hasMappingRecipient();
    if (mappingRecipient) {
      if (!mappingRecipient.values) {
        throw new Error("MAPPING_RECIPIENT kind requires a values field");
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const values = mappingRecipient!.values as { [k: string]: any };

      const recipient = inputs[recipientParam!.name] as string;
      const mappingValue = values[recipient];
      if (!mappingValue) {
        throw new Error("Unknown recipient");
      }

      // We autofill inputs[mappingRecipient] with the corresponding value
      inputs[mappingRecipient.name] = mappingValue;
    }

    // Now we check that all params have values and we can fill the arrays used to build the tx
    const txParamsTypes = [];
    const txParamsValues = [];
    for (const param of this.phase.tx.params ?? []) {
      const value = param.value ?? inputs[param.name];
      if (value === undefined || value === null) {
        throw new Error(`Parameter ${param.name} value missing`);
      }

      // Add the txParam to the build
      txParamsTypes.push(param.abiType);
      txParamsValues.push(value);
    }

    // Use ethers to build the tx
    const txParamsData = defaultAbiCoder.encode(txParamsTypes, txParamsValues);

    return {
      to: this.phase.tx.to,
      data: `${this.phase.tx.method}${txParamsData.slice(2)}`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  format(): any {
    const collection = this.parent.config.collection;
    const to = this.phase.tx.to;

    const params = [];
    for (const param of this.phase.tx.params ?? []) {
      params.push({
        kind: (param.kind ?? "unknown").toLowerCase(),
        abiType: param.abiType,
        abiValue: param.value,
      });
    }

    const mappingRecipient = this.hasMappingRecipient();

    const kind = mappingRecipient ? "allowlist" : "public";

    let additionalInfo;
    if (mappingRecipient) {
      additionalInfo = { mappingRecipient: mappingRecipient.values };
    }

    return {
      collection: collection,
      contract: collection,
      stage: `${kind}-sale`,
      kind,
      status: "open",
      standard: this.parent.config.standard || "unknown",
      details: {
        tx: {
          to,
          data: {
            signature: this.phase.tx.method,
            params,
          },
        },
        additionalInfo,
      },
      currency: this.phase.currency ?? AddressZero,
      price: this.phase.price ?? undefined,
      tokenId: this.phase.tokenId ?? undefined,
      maxMintsPerWallet: this.maxMintsPerWallet,
      maxMintsPerTransaction: this.maxMintPerTransaction,
      maxSupply: this.parent.maxSupply || undefined,
      startTime: this.startTime || undefined,
      endTime: this.endTime || undefined,
    };
  }
}
