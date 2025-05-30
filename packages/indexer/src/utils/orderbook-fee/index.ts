import { ApiKeyManager } from "@/models/api-keys";
import { FeeRecipients } from "@/models/fee-recipients";
import { OrderKind } from "@/orderbook/orders";
import {
  getPaymentSplitFromDb,
  generatePaymentSplit,
  getPaymentSplitBalance,
  supportsPaymentSplits,
  updatePaymentSplitBalance,
} from "@/utils/payment-splits";

export const FEE_RECIPIENT = "0x1208e7f7aed9d39ed25ef582b8933e4a1d0da6af";

export const ORDERBOOK_FEE_ORDER_KINDS: OrderKind[] = [
  "alienswap",
  "mintify",
  "payment-processor",
  "payment-processor-v2",
  "payment-processor-v2.1",
  "seaport-v1.4",
  "seaport-v1.5",
  "seaport-v1.6",
];

const SINGLE_FEE_ORDER_KINDS: OrderKind[] = [
  "payment-processor",
  "payment-processor-v2",
  "payment-processor-v2.1",
];

export const attachOrderbookFee = async (
  params: {
    fee?: string[];
    feeRecipient?: string[];
    orderKind: OrderKind;
    orderbook: string;
    currency: string;
  },
  apiKey = ""
) => {
  // Only native orders
  if (params.orderbook != "reservoir") {
    return;
  }

  const feeBps = await ApiKeyManager.getOrderbookFee(apiKey, params.orderKind);

  if (feeBps > 0) {
    params.fee = params.fee ?? [];
    params.feeRecipient = params.feeRecipient ?? [];

    // Handle single fee order kinds by using a payment split
    if (params.fee.length >= 1 && SINGLE_FEE_ORDER_KINDS.includes(params.orderKind)) {
      // Skip chains where payment splits are not supported
      if (!supportsPaymentSplits()) {
        return;
      }

      const paymentSplit = await generatePaymentSplit(
        {
          recipient: params.feeRecipient[0],
          bps: Number(params.fee),
        },
        {
          recipient: FEE_RECIPIENT,
          bps: feeBps,
        },
        apiKey
      );
      if (!paymentSplit) {
        throw new Error("Could not generate payment split");
      }

      // Keep track of the currency
      const balance = await getPaymentSplitBalance(paymentSplit.address, params.currency);
      if (!balance) {
        await updatePaymentSplitBalance(paymentSplit.address, params.currency, "0");
      }

      // Override
      params.feeRecipient = [paymentSplit.address];
      params.fee = [String(params.fee.map(Number).reduce((a, b) => a + b) + feeBps)];

      // Mark the fee as marketplace fee
      await FeeRecipients.getInstance().then((feeRecipients) =>
        feeRecipients.create(paymentSplit.address, "marketplace")
      );
    } else {
      params.fee.push(String(feeBps));
      params.feeRecipient.push(FEE_RECIPIENT);

      // Mark the fee as marketplace fee
      await FeeRecipients.getInstance().then((feeRecipients) =>
        feeRecipients.create(FEE_RECIPIENT, "marketplace")
      );
    }
  }
};

export const validateOrderbookFee = async (
  orderKind: OrderKind,
  feeBreakdown: {
    kind: string;
    recipient: string;
    bps: number;
  }[],
  apiKey = "",
  isReservoir?: boolean
) => {
  // Only native orders
  if (!isReservoir) {
    return;
  }

  // This is not the best place to add this check, but it does the job for now
  const totalBps = feeBreakdown.reduce((t, b) => t + b.bps, 0);
  if (totalBps > 10000) {
    throw new Error("invalid-fee");
  }

  const feeBps = await ApiKeyManager.getOrderbookFee(apiKey, orderKind);

  if (feeBps > 0) {
    let foundOrderbookFee = false;

    for (const fee of feeBreakdown) {
      if (
        fee.recipient.toLowerCase() === FEE_RECIPIENT.toLowerCase() &&
        // Allow off-by-one values to cover any precision issues
        [fee.bps - 1, fee.bps, fee.bps + 1].includes(feeBps)
      ) {
        foundOrderbookFee = true;
      }

      if (SINGLE_FEE_ORDER_KINDS.includes(orderKind)) {
        const paymentSplit = await getPaymentSplitFromDb(fee.recipient.toLowerCase());
        if (paymentSplit) {
          foundOrderbookFee = true;
        }
      }
    }

    if (!foundOrderbookFee) {
      throw new Error("missing-orderbook-fee");
    }
  }
};
