import * as Sdk from "@reservoir0x/sdk";
import { getSourceHash } from "@reservoir0x/sdk/dist/utils";

import { bn } from "@/common/utils";
import { config } from "@/config/index";
import * as erc721c from "@/utils/erc721c";

export interface BaseOrderBuildOptions {
  maker: string;
  taker?: string;
  contract?: string;
  weiPrice: string;
  endWeiPrice?: string;
  orderbook: "opensea" | "reservoir" | "looks-rare";
  useOffChainCancellation?: boolean;
  replaceOrderId?: string;
  orderType?: Sdk.SeaportBase.Types.OrderType;
  currency?: string;
  quantity?: number;
  nonce?: string;
  fee?: number[];
  feeRecipient?: string[];
  listingTime?: number;
  expirationTime?: number;
  salt?: string;
  automatedRoyalties?: boolean;
  royaltyBps?: number;
  excludeFlaggedTokens?: boolean;
  source?: string;
  conduitKey?: string;
}

export type OrderBuildInfo = {
  params: Sdk.SeaportBase.BaseBuildParams;
  kind: "erc721" | "erc1155";
};

export const padSourceToSalt = (salt: string, source?: string) => {
  const prefix =
    source === "reservoir.tools"
      ? getSourceHash(source)
      : getSourceHash(source) + getSourceHash("reservoir.tools");
  const saltPaddedTo32Bytes = bn(salt).toHexString().slice(2).padStart(64, "0");
  return bn(`0x${prefix}${saltPaddedTo32Bytes.slice(prefix.length)}`).toString();
};

export const contractUsesOSTransferValidator = async (contract: string) => {
  const erc721cConfigV2 = await erc721c.v2.getConfigFromDb(contract);

  const osCustomTransferValidator =
    Sdk.Erc721c.Addresses.OpenSeaCustomTransferValidator[config.chainId];
  if (
    osCustomTransferValidator &&
    erc721cConfigV2 &&
    erc721cConfigV2.transferValidator === osCustomTransferValidator
  ) {
    return true;
  }

  return false;
};
