import * as Sdk from "@reservoir0x/sdk";

import { baseProvider } from "@/common/provider";
import { bn } from "@/common/utils";
import { config } from "@/config/index";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import * as onChainData from "@/utils/on-chain-data";

export const offChainCheck = async (
  order: Sdk.PaymentProcessorV21.Order,
  options?: {
    // Some NFTs pre-approve common exchanges so that users don't
    // spend gas approving them. In such cases we will be missing
    // these pre-approvals from the local database and validation
    // purely from off-chain state can be inaccurate. In order to
    // handle this, we allow the option to double validate orders
    // on-chain in case off-chain validation returns the order as
    // being invalid.
    onChainApprovalRecheck?: boolean;
    checkFilledOrCancelled?: boolean;
  }
) => {
  const id = order.hash();
  const orderKind = "payment-processor-v2.1";

  // Check: order has a valid target
  const kind = await commonHelpers.getContractKind(order.params.tokenAddress);
  if (!kind) {
    throw new Error("invalid-target");
  }
  if (!["erc1155", "erc721", "erc721-like"].includes(kind)) {
    throw new Error("invalid-target");
  }
  if (
    ["erc1155"].includes(kind) &&
    ![
      Sdk.PaymentProcessorV21.Types.OrderProtocols.ERC1155_FILL_OR_KILL,
      Sdk.PaymentProcessorV21.Types.OrderProtocols.ERC1155_FILL_PARTIAL,
    ].includes(order.params.protocol)
  ) {
    throw new Error("invalid-target");
  }
  if (
    ["erc721", "erc721-like"].includes(kind) &&
    ![Sdk.PaymentProcessorV21.Types.OrderProtocols.ERC721_FILL_OR_KILL].includes(
      order.params.protocol
    )
  ) {
    throw new Error("invalid-target");
  }

  if (options?.checkFilledOrCancelled) {
    // Check: order is not cancelled
    const cancelled = await commonHelpers.isOrderCancelled(id, orderKind);
    if (cancelled) {
      throw new Error("cancelled");
    }

    // Check: order is not filled
    const quantityFilled = await commonHelpers.getQuantityFilled(id);
    if (quantityFilled.gte(order.params.amount)) {
      throw new Error("filled");
    }
  }

  // Check: order's nonce was not bulk cancelled
  const minNonce = await commonHelpers.getMinNonce(orderKind, order.params.sellerOrBuyer);
  if (minNonce.gt(order.params.masterNonce)) {
    throw new Error("cancelled");
  }

  // Check: order's nonce was not individually cancelled
  const nonceCancelled = await commonHelpers.isNonceCancelled(
    orderKind,
    order.params.sellerOrBuyer,
    order.params.nonce
  );

  if (nonceCancelled) {
    throw new Error("cancelled");
  }

  let hasBalance = true;
  let hasApproval = true;
  if (order.isBuyOrder()) {
    const balanceToCheck = bn(order.params.itemPrice).mul(order.params.amount);

    // Check: maker has enough balance
    const ftBalance = await commonHelpers.getFtBalance(
      order.params.paymentMethod,
      order.params.sellerOrBuyer
    );
    if (ftBalance.lt(balanceToCheck)) {
      hasBalance = false;
    }

    if (options?.onChainApprovalRecheck) {
      if (
        bn(
          await onChainData
            .fetchAndUpdateFtApproval(
              order.params.paymentMethod,
              order.params.sellerOrBuyer,
              Sdk.PaymentProcessorV21.Addresses.Exchange[config.chainId],
              true
            )
            .then((a) => a.value)
        ).lt(balanceToCheck)
      ) {
        hasApproval = false;
      }
    }
  } else {
    // Check: maker has enough balance
    const nftBalance = await commonHelpers.getNftBalance(
      order.params.tokenAddress,
      order.params.tokenId!,
      order.params.sellerOrBuyer
    );
    if (nftBalance.lt(order.params.amount)) {
      hasBalance = false;
    }

    const operator = Sdk.PaymentProcessorV21.Addresses.Exchange[config.chainId];

    // Check: maker has set the proper approval
    const nftApproval = await commonHelpers.getNftApproval(
      order.params.tokenAddress,
      order.params.sellerOrBuyer,
      operator
    );
    if (!nftApproval) {
      if (options?.onChainApprovalRecheck) {
        // Re-validate the approval on-chain to handle some edge-cases
        const contract =
          kind === "erc721"
            ? new Sdk.Common.Helpers.Erc721(baseProvider, order.params.tokenAddress)
            : new Sdk.Common.Helpers.Erc1155(baseProvider, order.params.tokenAddress);
        if (!(await contract.isApproved(order.params.sellerOrBuyer, operator))) {
          hasApproval = false;
        }
      } else {
        hasApproval = false;
      }
    }
  }

  if (!hasBalance && !hasApproval) {
    throw new Error("no-balance-no-approval");
  } else if (!hasBalance) {
    throw new Error("no-balance");
  } else if (!hasApproval) {
    throw new Error("no-approval");
  }
};
