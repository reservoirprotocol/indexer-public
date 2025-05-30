import { getCallResult, getCallTraceLogs } from "@georgeroman/evm-tx-simulator";
import { Log } from "@georgeroman/evm-tx-simulator/dist/types";
import * as Sdk from "@reservoir0x/sdk";
import { Network, TxData } from "@reservoir0x/sdk/dist/utils";

import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProviderWithTimeout } from "@/common/provider";
import { bn } from "@/common/utils";
import { config } from "@/config/index";
import { CollectionMint, PricePerQuantity } from "@/orderbook/mints";
import { generateCollectionMintTxData } from "@/orderbook/mints/calldata";

import { EventData } from "@/events-sync/data";
import * as erc721 from "@/events-sync/data/erc721";
import * as erc1155 from "@/events-sync/data/erc1155";
import { JsonRpcProvider } from "@ethersproject/providers";

export const simulateCollectionMint = async (
  collectionMint: CollectionMint,
  // When true and the collection mint doesn't have any predefined `maxMintsPerWallet`
  // then we'll try to detect `maxMintsPerWallet` by simulating with various quantites
  detectMaxMintsPerWallet = true,
  // This field should only be used for "premint" collections (which might not yet be
  // available in the `collections` and / or `contracts` tables)
  assumeContractKind?: "erc721" | "erc1155"
) => {
  // Cache and unset `pricePerQuantity` since having it set on the
  // collection mint is just a hacky way to pass it through all of
  // the mint related methods. If this field is actually needed it
  // it will be set via the `simulateViaPricePerQuantity` method.
  const pricePerQuantity = collectionMint.pricePerQuantity;
  collectionMint.pricePerQuantity = undefined;

  // TODO: Add support for simulating non-public mints
  if (collectionMint.kind !== "public") {
    return collectionMint.status === "open";
  }

  // Some network don't support the RPC calls the simulation depends on,
  // so in this case we only let through mints having a known standard
  if (
    [Network.PolygonZkevm, Network.AstarZkevm, Network.Zksync, Network.Scroll].includes(
      config.chainId
    )
  ) {
    return collectionMint.standard !== "unknown";
  }

  // Fetch the collection's kind (only if `assumeContractKind` is missing)
  let contractKind: "erc721" | "erc1155";
  if (!assumeContractKind) {
    const collectionResult = await idb.oneOrNone(
      `
        SELECT
          collections.contract,
          contracts.kind
        FROM collections
        JOIN contracts
          ON collections.contract = contracts.address
        WHERE collections.id = $/collection/
      `,
      { collection: collectionMint.collection }
    );
    if (!collectionResult) {
      logger.info(
        "mints-simulation",
        JSON.stringify({
          message: `Missing collection. collection=${collectionMint.collection}`,
        })
      );

      return false;
    }

    contractKind = collectionResult.kind;
  } else {
    contractKind = assumeContractKind;
  }

  // Skip simulation of ERC20 mints for now (since it requires multiple transactions)
  if (collectionMint.currency !== Sdk.Common.Addresses.Native[config.chainId]) {
    return true;
  }

  const minter = "0x0000000000000000000000000000000000000001";

  const simulate = async (quantity: number) =>
    // Generate and simulate the mint transaction
    generateCollectionMintTxData(collectionMint, minter, quantity).then(({ txData }) =>
      simulateMintTxData(collectionMint.contract, contractKind, quantity, txData)
    );

  const simulateViaPricePerQuantity = async (
    collectionMint: CollectionMint,
    pricePerQuantity: PricePerQuantity[]
  ) => {
    const validPricePerQuantityEntries = [];
    for (const { price, quantity } of pricePerQuantity) {
      // Create a temporary collection mint with the current price per quantity
      const tmpCollectionMint = {
        ...collectionMint,
        price,
      };

      // Simulate
      const result = await generateCollectionMintTxData(tmpCollectionMint, minter, quantity).then(
        ({ txData }) => simulateMintTxData(collectionMint.contract, contractKind, quantity, txData)
      );

      // If the simulation was successful then the current price per quantity is valid
      if (result) {
        validPricePerQuantityEntries.push({ price, quantity });
      }
    }

    // Need at least one valid price per quantity entry
    if (validPricePerQuantityEntries.length) {
      // Unset `price` and set `pricePerQuantity`
      collectionMint.price = undefined;
      collectionMint.pricePerQuantity = validPricePerQuantityEntries;
      return true;
    }

    return false;
  };

  if (
    detectMaxMintsPerWallet &&
    collectionMint.maxMintsPerWallet === undefined &&
    collectionMint.maxMintsPerTransaction != "1"
  ) {
    const quantitiesToTry = [1, 2, 5, 10, 11];
    const results = await Promise.all(quantitiesToTry.map((q) => simulate(q)));

    if (results.every((r) => r)) {
      // Explicitly set to `undefined` which means an unlimited amount can be minted
      collectionMint.maxMintsPerWallet = undefined;
    } else {
      // Find first quantity that failed, and take the one before it as the maximum
      const firstFailedIndex = results.findIndex((r) => !r);
      if (firstFailedIndex === 0) {
        // Try any price per quantity entries
        if (pricePerQuantity?.length) {
          return simulateViaPricePerQuantity(collectionMint, pricePerQuantity);
        }

        return false;
      } else {
        collectionMint.maxMintsPerWallet = quantitiesToTry[firstFailedIndex - 1].toString();
      }
    }

    return true;
  } else {
    return simulate(1);
  }
};

type NFTTransferEvent = {
  contract: string;
  from: string;
  to: string;
  tokenId: string;
  amount: string;
};

export const getNFTTransferEvents = async (
  txData: TxData,
  provider?: JsonRpcProvider
): Promise<NFTTransferEvent[]> => {
  try {
    const logs = await getEmittedEvents(txData, config.chainId, provider);

    const matchesEventData = (log: Log, eventData: EventData) =>
      log.topics[0] === eventData.topic && log.topics.length === eventData.numTopics;

    const events: NFTTransferEvent[] = [];
    for (const log of logs) {
      if (matchesEventData(log, erc721.transfer)) {
        // ERC721 `Transfer`
        const parsedLog = erc721.transfer.abi.parseLog(log);
        events.push({
          contract: log.address.toLowerCase(),
          from: parsedLog.args["from"].toLowerCase(),
          to: parsedLog.args["to"].toLowerCase(),
          tokenId: parsedLog.args["tokenId"].toString(),
          amount: "1",
        });
      } else if (matchesEventData(log, erc1155.transferSingle)) {
        // ERC1155 `TransferSingle`
        const parsedLog = erc1155.transferSingle.abi.parseLog(log);
        events.push({
          contract: log.address.toLowerCase(),
          from: parsedLog.args["from"].toLowerCase(),
          to: parsedLog.args["to"].toLowerCase(),
          tokenId: parsedLog.args["tokenId"].toString(),
          amount: parsedLog.args["amount"].toString(),
        });
      } else if (matchesEventData(log, erc1155.transferBatch)) {
        // ERC1155 `TransferBatch`
        const parsedLog = erc1155.transferBatch.abi.parseLog(log);
        for (let i = 0; i < parsedLog.args["amounts"].length; i++) {
          events.push({
            contract: log.address.toLowerCase(),
            from: parsedLog.args["from"].toLowerCase(),
            to: parsedLog.args["to"].toLowerCase(),
            tokenId: parsedLog.args["tokenIds"][i].toString(),
            amount: parsedLog.args["amounts"][i].toString(),
          });
        }
      }
    }

    return events;
  } catch (error) {
    logger.debug(
      "getNFTTransferEvents",
      JSON.stringify({
        topic: "dedicatedRpcNode",
        message: `getEmittedEvents error. error=${error}`,
        error,
        txData,
        providerUrl: provider?.connection.url,
      })
    );
  }

  return [];
};

const simulateMintTxData = async (
  contract: string,
  contractKind: "erc721" | "erc1155",
  quantity: number,
  txData: TxData
) => {
  if (
    [
      Network.Ethereum,
      Network.EthereumSepolia,
      Network.Optimism,
      // Network.Polygon,
      // Network.Arbitrum,
      Network.Bsc,
      Network.Zora,
      Network.Base,
      Network.Ancient8Testnet,
    ].includes(config.chainId)
  ) {
    // CASE 1
    // If supported, use `debug_traceCall` (very accurate)

    let logs: Log[];

    try {
      logs = await getEmittedEvents(txData, config.chainId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.debug(
        "mints-simulation",
        JSON.stringify({
          topic: "dedicatedRpcNode",
          message: `getEmittedEvents error. contract=${contract}, error=${error}`,
          contract,
          contractKind,
          quantity,
          txData,
          error,
          stack: error.stack,
        })
      );

      // We want to avoid marking mints as closed due to rpc internal errors
      if (error.message && !error.message.includes("reverted")) {
        logger.info(
          "mints-simulation",
          JSON.stringify({
            message: `getEmittedEvents error. contract=${contract}, error=${error}`,
            contract,
            contractKind,
            quantity,
            txData,
            error,
          })
        );

        throw error;
      }

      return false;
    }

    const matchesEventData = (log: Log, eventData: EventData) =>
      log.address.toLowerCase() === contract &&
      log.topics[0] === eventData.topic &&
      log.topics.length === eventData.numTopics;

    let count = bn(0);
    for (const log of logs) {
      if (contractKind === "erc721") {
        // ERC721 `Transfer`
        if (matchesEventData(log, erc721.transfer)) {
          const parsedLog = erc721.transfer.abi.parseLog(log);
          if (parsedLog.args["to"] === txData.from) {
            count = count.add(1);
          }
        }
      } else if (contractKind === "erc1155") {
        // ERC1155 `TransferSingle`
        if (matchesEventData(log, erc1155.transferSingle)) {
          const parsedLog = erc1155.transferSingle.abi.parseLog(log);
          if (parsedLog.args["to"] === txData.from) {
            count = count.add(parsedLog.args["amount"]);
          }
          // ERC1155 `TransferBatch`
        } else if (matchesEventData(log, erc1155.transferBatch)) {
          const parsedLog = erc1155.transferBatch.abi.parseLog(log);
          if (parsedLog.args["to"] === txData.from) {
            count = count.add(parsedLog.args["amounts"][0]);
          }
        }
      }
    }

    if (count.toString() === String(quantity)) {
      return true;
    }

    return false;
  } else {
    // CASE 2
    // Default to using `eth_call` (which isn't very accurate)

    try {
      await triggerCall(txData);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      // We want to avoid marking mints as closed due to rpc internal errors
      if (error.message && !error.message.includes("reverted")) {
        logger.info(
          "mints-simulation",
          JSON.stringify({
            contract,
            contractKind,
            quantity,
            txData,
            error,
            stack: error.stack,
          })
        );

        throw error;
      }

      return false;
    }

    return true;
  }
};

const getEmittedEvents = async (txData: TxData, chainId: number, provider?: JsonRpcProvider) => {
  const value = txData.value ?? bn(0);

  return getCallTraceLogs(
    {
      from: txData.from,
      to: txData.to,
      data: txData.data,
      value,
      gas: 10000000,
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      balanceOverrides: {
        [txData.from]: value,
      },
    },
    provider ?? baseProviderWithTimeout(5000),
    {
      method: [Network.Polygon, Network.Arbitrum].includes(chainId) ? "opcodeTrace" : "withLog",
    }
  );
};

const triggerCall = async (txData: TxData) => {
  const value = bn(txData.value ?? 0);

  return getCallResult(
    {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      from: config.chainId === Network.MonadTestnet ? null : txData.from,
      to: txData.to,
      data: txData.data,
      value,
      gas: 10000000,
      maxFeePerGas: 0,
      maxPriorityFeePerGas: 0,
      balanceOverrides: {
        [txData.from]: value,
      },
    },
    baseProviderWithTimeout(5000)
  );
};
