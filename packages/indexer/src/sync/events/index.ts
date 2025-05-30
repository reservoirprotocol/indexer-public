import { BlockWithTransactions, Filter } from "@ethersproject/abstract-provider";
import _ from "lodash";
import getUuidByString from "uuid-by-string";

import { logger } from "@/common/logger";
import { archiveProvider, backfillProvider, baseProvider } from "@/common/provider";
import { acquireLock, redis } from "@/common/redis";
import { config } from "@/config/index";
import { EventKind, EventSubKind, getEventData } from "@/events-sync/data";
import { EventsBatch, EventsByKind, processEventsBatchV2 } from "@/events-sync/handlers";
import { EnhancedEvent } from "@/events-sync/handlers/utils";
import { parseEvent } from "@/events-sync/parser";
import * as es from "@/events-sync/storage";
import * as syncEventsUtils from "@/events-sync/utils";
import * as blocksModel from "@/models/blocks";

import { removeUnsyncedEventsActivitiesJob } from "@/jobs/elasticsearch/activities/remove-unsynced-events-activities-job";
import { blockCheckJob } from "@/jobs/events-sync/block-check-queue-job";
import { eventsSyncRealtimeJob } from "@/jobs/events-sync/events-sync-realtime-job";
import { saveRedisTransactionsJob } from "@/jobs/events-sync/save-redis-transactions-job";
import { HashZero } from "@ethersproject/constants";
import { JsonRpcProvider } from "@ethersproject/providers";

export interface SyncBlockOptions {
  skipLogsCheck?: boolean;
  syncDetails?:
    | {
        method: "events";
        events?: string[];
        eventsType?: string[];
      }
    | {
        method: "address";
        address: string;
      };
  backfill?: boolean;
  syncEventsOnly?: boolean;
  blocksPerBatch?: number;
  skipTransactions?: boolean;
  useArchiveRpcProvider?: boolean;
  useBackfillRpcProvider?: boolean;
}

export interface SyncEventsData {
  blockEventTimeReceived?: number;
  rabbitMqMessagePublishTime?: number;
}

export const extractEventsBatches = (enhancedEvents: EnhancedEvent[]): EventsBatch[] => {
  const txHashToEvents = new Map<string, EnhancedEvent[]>();

  enhancedEvents.forEach((event) => {
    const txHash = event.baseEventParams.txHash;
    if (!txHashToEvents.has(txHash)) {
      txHashToEvents.set(txHash, []);
    }
    txHashToEvents.get(txHash)!.push(event);
  });

  const txHashToEventsBatch = new Map<string, EventsBatch>();

  [...txHashToEvents.entries()].forEach(([txHash, events]) => {
    const kindToEvents = new Map<EventKind, EnhancedEvent[]>();
    let blockHash = "";
    let logIndex = null;
    let batchIndex = null;

    for (const event of events) {
      if (!kindToEvents.has(event.kind)) {
        kindToEvents.set(event.kind, []);
      }

      if (!blockHash) {
        blockHash = event.baseEventParams.blockHash;
        logIndex = event.baseEventParams.logIndex;
        batchIndex = event.baseEventParams.batchIndex;
      }

      kindToEvents.get(event.kind)!.push(event);
    }

    const eventsByKind: EventsByKind[] = [
      {
        kind: "erc20",
        data: kindToEvents.get("erc20") ?? [],
      },
      {
        kind: "erc721",
        data: kindToEvents.get("erc721") ?? [],
      },
      {
        kind: "erc1155",
        data: kindToEvents.get("erc1155") ?? [],
      },
      {
        kind: "blur",
        data: kindToEvents.get("blur") ?? [],
      },
      {
        kind: "cryptopunks",
        data: kindToEvents.get("cryptopunks") ?? [],
      },
      {
        kind: "decentraland",
        data: kindToEvents.get("decentraland") ?? [],
      },
      {
        kind: "element",
        data: kindToEvents.get("element") ?? [],
      },
      {
        kind: "foundation",
        data: kindToEvents.get("foundation") ?? [],
      },
      {
        kind: "looks-rare",
        data: kindToEvents.has("looks-rare")
          ? [
              ...kindToEvents.get("looks-rare")!,
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
            ]
          : [],
      },
      {
        kind: "nftx",
        data: kindToEvents.get("nftx") ?? [],
      },
      {
        kind: "nftx-v3",
        data: kindToEvents.get("nftx-v3") ?? [],
      },
      {
        kind: "nouns",
        data: kindToEvents.get("nouns") ?? [],
      },
      {
        kind: "quixotic",
        data: kindToEvents.get("quixotic") ?? [],
      },
      {
        kind: "seaport",
        data: kindToEvents.has("seaport")
          ? [
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
              ...kindToEvents.get("seaport")!,
            ]
          : [],
      },
      {
        kind: "sudoswap",
        data: kindToEvents.get("sudoswap") ?? [],
      },
      {
        kind: "sudoswap-v2",
        data: kindToEvents.get("sudoswap-v2") ?? [],
      },
      {
        kind: "wyvern",
        data: kindToEvents.has("wyvern")
          ? [
              ...events.filter((e) => e.subKind === "erc721-transfer"),
              ...kindToEvents.get("wyvern")!,
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
            ]
          : [],
      },
      {
        kind: "x2y2",
        data: kindToEvents.has("x2y2")
          ? [
              ...kindToEvents.get("x2y2")!,
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
            ]
          : [],
      },
      {
        kind: "zeroex-v4",
        data: kindToEvents.has("zeroex-v4")
          ? [
              ...kindToEvents.get("zeroex-v4")!,
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
            ]
          : [],
      },
      {
        kind: "zora",
        data: kindToEvents.get("zora")
          ? [
              ...kindToEvents.get("zora")!,
              ...events.filter((e) => e.kind === "erc721"),
              ...events.filter((e) => e.kind === "erc1155"),
            ]
          : [],
      },
      {
        kind: "rarible",
        data: kindToEvents.has("rarible")
          ? [
              ...kindToEvents.get("rarible")!,
              // To properly validate bids, we need some additional events
              ...events.filter((e) => e.subKind === "erc20-transfer"),
            ]
          : [],
      },
      {
        kind: "manifold",
        data: kindToEvents.get("manifold") ?? [],
      },
      {
        kind: "tofu",
        data: kindToEvents.get("tofu") ?? [],
      },
      {
        kind: "bend-dao",
        data: kindToEvents.get("bend-dao") ?? [],
      },
      {
        kind: "nft-trader",
        data: kindToEvents.get("nft-trader") ?? [],
      },
      {
        kind: "okex",
        data: kindToEvents.get("okex") ?? [],
      },
      {
        kind: "superrare",
        data: kindToEvents.get("superrare") ?? [],
      },
      {
        kind: "zeroex-v2",
        data: kindToEvents.get("zeroex-v2") ?? [],
      },
      {
        kind: "zeroex-v3",
        data: kindToEvents.get("zeroex-v3") ?? [],
      },
      {
        kind: "treasure",
        data: kindToEvents.get("treasure") ?? [],
      },
      {
        kind: "looks-rare-v2",
        data: kindToEvents.get("looks-rare-v2") ?? [],
      },
      {
        kind: "blend",
        data: kindToEvents.get("blend") ?? [],
      },
      {
        kind: "payment-processor",
        data: kindToEvents.get("payment-processor") ?? [],
      },
      {
        kind: "thirdweb",
        data: kindToEvents.get("thirdweb") ?? [],
      },
      {
        kind: "seadrop",
        data: kindToEvents.get("seadrop") ?? [],
      },
      {
        kind: "blur-v2",
        data: kindToEvents.get("blur-v2") ?? [],
      },
      {
        kind: "erc721c",
        data: kindToEvents.get("erc721c") ?? [],
      },
      {
        kind: "createdotfun",
        data: kindToEvents.get("createdotfun") ?? [],
      },
      {
        kind: "payment-processor-registry",
        data: kindToEvents.get("payment-processor-registry") ?? [],
      },
      {
        kind: "payment-processor-v2",
        data: kindToEvents.get("payment-processor-v2") ?? [],
      },
      {
        kind: "payment-processor-v2.1",
        data: kindToEvents.get("payment-processor-v2.1") ?? [],
      },
      {
        kind: "titlesxyz",
        data: kindToEvents.get("titlesxyz") ?? [],
      },
      {
        kind: "artblocks",
        data: kindToEvents.get("artblocks") ?? [],
      },
      {
        kind: "ditto",
        data: kindToEvents.get("ditto") ?? [],
      },
      {
        kind: "mooar",
        data: kindToEvents.get("mooar") ?? [],
      },
      {
        kind: "highlightxyz",
        data: kindToEvents.get("highlightxyz") ?? [],
      },
      {
        kind: "fairxyz",
        data: kindToEvents.get("fairxyz") ?? [],
      },
      {
        kind: "operator-filter",
        data: kindToEvents.get("operator-filter") ?? [],
      },
      {
        kind: "metadata-update",
        data: kindToEvents.get("metadata-update") ?? [],
      },
      {
        kind: "coinbase",
        data: kindToEvents.get("coinbase") ?? [],
      },
      {
        kind: "magiceden",
        data: kindToEvents.get("magiceden") ?? [],
      },
    ];

    txHashToEventsBatch.set(txHash, {
      id: getUuidByString(`${txHash}:${logIndex}:${batchIndex}:${blockHash}`),
      events: eventsByKind,
    });
  });

  return [...txHashToEventsBatch.values()];
};

const _getLogs = async (eventFilter: Filter, provider?: JsonRpcProvider) => {
  const timerStart = Date.now();

  if (provider) {
    logger.debug(
      "_getLogs",
      JSON.stringify({
        topic: "dedicatedRpcNode",
        message: `_getLogs. fromBlock=${eventFilter.fromBlock}, toBlock=${eventFilter.toBlock}`,
        providerUrl: provider.connection.url,
      })
    );
  }

  const logs = provider
    ? await provider.getLogs(eventFilter)
    : await baseProvider.getLogs(eventFilter);
  const timerEnd = Date.now();
  return {
    logs,
    getLogsTime: timerEnd - timerStart,
  };
};

const _saveBlock = async (blockData: blocksModel.Block) => {
  const timerStart = Date.now();
  await blocksModel.saveBlock(blockData);
  const timerEnd = Date.now();
  return {
    saveBlocksTime: timerEnd - timerStart,
    endSaveBlocksTime: timerEnd,
  };
};

export const _saveBlockTransactions = async (blockData: BlockWithTransactions) => {
  const timerStart = Date.now();
  await syncEventsUtils.saveBlockTransactions(blockData);
  const timerEnd = Date.now();
  return timerEnd - timerStart;
};

const _saveBlockTransactionsToRedis = async (blockData: BlockWithTransactions) => {
  const timerStart = Date.now();
  await syncEventsUtils.saveBlockTransactionsRedis(blockData);
  const timerEnd = Date.now();
  return timerEnd - timerStart;
};

export const syncTraces = async (block: number, provider?: JsonRpcProvider) => {
  const startSyncTime = Date.now();
  const startGetBlockTime = Date.now();

  // try to get from redis first
  const blockDataRedis = await redis.get(`block:${block}`);
  let blockData;
  if (blockDataRedis) {
    blockData = JSON.parse(blockDataRedis);
  } else {
    // if not found in redis, get from RPC
    blockData = await syncEventsUtils.fetchBlock(block, provider);
  }

  if (!blockData) {
    throw new Error(`Block ${block} not found with RPC provider`);
  }

  if (blockData.transactions.length === 0) {
    return;
  }

  const { traces, getTransactionTracesTime } = await syncEventsUtils._getTransactionTraces(
    blockData.transactions,
    block,
    provider
  );

  const endGetBlockTime = Date.now();

  // Do what we want with traces here
  await Promise.all([syncEventsUtils.processContractAddresses(traces, blockData.timestamp)]);

  const endSyncTime = Date.now();

  logger.debug(
    "sync-traces-timing",
    JSON.stringify({
      message: `Traces realtime syncing block ${block}`,
      block,
      syncTime: endSyncTime - startSyncTime,
      blockSyncTime: endSyncTime - startSyncTime,

      traces: {
        count: traces.length,
        getTransactionTracesTime,
      },
      blocks: {
        count: 1,
        getBlockTime: endGetBlockTime - startGetBlockTime,
        blockMinedTimestamp: blockData.timestamp,
        startJobTimestamp: startSyncTime,
        getBlockTimestamp: endGetBlockTime,
      },
    })
  );
};

export const getBlocks = async (fromBlock: number, toBlock: number, provider?: JsonRpcProvider) => {
  const blocks = await Promise.all(
    _.range(fromBlock, toBlock + 1).map(async (block) => {
      const blockData = await syncEventsUtils.fetchBlock(block, provider);
      if (!blockData) {
        throw new Error(`Block ${block} not found with RPC provider`);
      }
      return blockData;
    })
  );

  return blocks;
};

export const syncEventsOnly = async (
  blocks: {
    fromBlock: number;
    toBlock: number;
  },
  syncOptions?: SyncBlockOptions
) => {
  const startSyncTime = Date.now();
  let rpcProvider: JsonRpcProvider | undefined = undefined;

  if (config.genesisBlock) {
    blocks.fromBlock = _.max([config.genesisBlock, blocks.fromBlock])!;
    blocks.toBlock = _.max([blocks.fromBlock, blocks.toBlock])!;
  }

  if (syncOptions?.useArchiveRpcProvider) {
    rpcProvider = archiveProvider;
  } else if (syncOptions?.useBackfillRpcProvider) {
    rpcProvider = backfillProvider;
  }

  const eventFilter: Filter = {
    topics: [[...new Set(getEventData().map(({ topic }) => topic))]],
    fromBlock: blocks?.fromBlock,
    toBlock: blocks?.toBlock,
  };

  if (syncOptions?.syncDetails?.method === "events" && syncOptions?.syncDetails?.events) {
    // Filter to a subset of events, remove any duplicates
    eventFilter.topics = [
      [
        ...new Set(
          getEventData(syncOptions.syncDetails.events.map((event) => event as EventSubKind)).map(
            ({ topic }) => topic
          )
        ),
      ],
    ];
  } else if (syncOptions?.syncDetails?.method === "address") {
    // Filter to all events of a particular address (regardless of the topics)
    eventFilter.address = syncOptions.syncDetails.address;
    eventFilter.topics = undefined;
  }

  const availableEventData = getEventData();
  const { logs, getLogsTime } = await _getLogs(eventFilter, rpcProvider);

  const blockNumbersFromLogs = [...new Set(logs.map((log) => log.blockNumber))];
  const blockTimestamps: { [blockNumber: number]: number } = {};

  await Promise.all(
    blockNumbersFromLogs.map(async (blockNumber) => {
      const blockData = await syncEventsUtils.fetchBlock(blockNumber, rpcProvider);
      if (!blockData) {
        throw new Error(`Block ${blockNumber} not found with RPC provider`);
      }
      blockTimestamps[blockNumber] = blockData.timestamp;
    })
  );

  // fetch tx data for logs that we are interested in
  const txHashes = [...new Set(logs.map((log) => log.transactionHash))];
  const txData = await Promise.all(
    txHashes.map(async (txHash) => {
      const tx = syncOptions?.useArchiveRpcProvider
        ? await archiveProvider.getTransaction(txHash)
        : syncOptions?.useBackfillRpcProvider
        ? await backfillProvider.getTransaction(txHash)
        : await baseProvider.getTransaction(txHash);
      if (!tx) {
        throw new Error(`Transaction ${txHash} not found with RPC provider`);
      }
      return tx;
    })
  );

  let enhancedEvents = logs
    .map((log) => {
      try {
        const tx = txData.find((tx) => tx.hash === log.transactionHash);
        if (!tx) {
          throw new Error(`Transaction ${log.transactionHash} not found with RPC provider`);
        }
        const baseEventParams = parseEvent(log, blockTimestamps[log.blockNumber], 1, tx);
        return availableEventData
          .filter(
            ({ addresses, numTopics, topic }) =>
              log.topics[0] === topic &&
              log.topics.length === numTopics &&
              (addresses ? addresses[log.address.toLowerCase()] : true)
          )
          .map((eventData) => ({
            kind: eventData.kind,
            subKind: eventData.subKind,
            baseEventParams,
            log,
          }));
      } catch (error) {
        logger.error("sync-events-v2", `Failed to handle events (syncEventsOnly): ${error}`);
        throw error;
      }
    })
    .flat();

  enhancedEvents = enhancedEvents.filter((e) => e) as EnhancedEvent[];

  // Process the retrieved events
  const eventsBatches = extractEventsBatches(enhancedEvents as EnhancedEvent[]);

  const startProcessLogs = Date.now();

  const processEventsLatencies = await processEventsBatchV2(eventsBatches, syncOptions);

  const endProcessLogs = Date.now();

  const endSyncTime = Date.now();

  logger.info(
    "sync-events-batch-timing-v2",
    JSON.stringify({
      message: `Events realtime syncing blocks ${blocks.fromBlock} to ${blocks.toBlock}`,
      blockRange: [blocks.fromBlock, blocks.toBlock],
      syncTime: endSyncTime - startSyncTime,

      logs: {
        count: logs.length,
        eventCount: enhancedEvents.length,
        getLogsTime,
        processLogs: endProcessLogs - startProcessLogs,
      },

      processEventsLatencies: processEventsLatencies,
    })
  );
};

export const syncEvents = async (
  blocks: {
    fromBlock: number;
    toBlock: number;
  },
  syncOptions?: SyncBlockOptions,
  syncEventsData?: SyncEventsData
) => {
  const startSyncTime = Date.now();
  let rpcProvider: JsonRpcProvider | undefined = undefined;

  if (config.genesisBlock) {
    blocks.fromBlock = _.max([config.genesisBlock, blocks.fromBlock])!;
    blocks.toBlock = _.max([blocks.fromBlock, blocks.toBlock])!;
  }

  if (syncOptions?.useArchiveRpcProvider) {
    rpcProvider = archiveProvider;
  } else if (syncOptions?.useBackfillRpcProvider) {
    rpcProvider = backfillProvider;
  }

  const startGetBlockTime = Date.now();
  const blockData = await getBlocks(blocks.fromBlock, blocks.toBlock, rpcProvider);

  if (!blockData) {
    throw new Error(`Blocks ${blocks.fromBlock} to ${blocks.toBlock} not found with RPC provider`);
  }

  const endGetBlockTime = Date.now();

  const eventFilter: Filter = {
    topics: [[...new Set(getEventData().map(({ topic }) => topic))]],
    fromBlock: blocks?.fromBlock,
    toBlock: blocks?.toBlock,
  };

  if (syncOptions?.syncDetails?.method === "events" && syncOptions?.syncDetails?.events) {
    // Filter to a subset of events, remove any duplicates
    eventFilter.topics = [
      [
        ...new Set(
          getEventData(syncOptions.syncDetails.events.map((event) => event as EventSubKind)).map(
            ({ topic }) => topic
          )
        ),
      ],
    ];
  } else if (syncOptions?.syncDetails?.method === "address") {
    // Filter to all events of a particular address (regardless of the topics)
    eventFilter.address = syncOptions.syncDetails.address;
    eventFilter.topics = undefined;
  }

  const availableEventData = getEventData();

  // Get the logs from the RPC
  const { logs, getLogsTime } = await _getLogs(eventFilter, rpcProvider);

  // Filter out transactions that we have no log for (we don't want to save these transactions)
  if ([137, 324].includes(config.chainId)) {
    blockData.forEach((block) => {
      block.transactions = block.transactions.filter((tx) =>
        logs.find((log) => log.transactionHash === tx.hash)
      );
    });
  }

  const saveDataTimes = await Promise.all([
    ...blockData.map(async (block) => {
      return await Promise.all([
        _saveBlock({
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp,
        }),
        // If the fromBlock/toBlock are the same, that means this
        // is from realtime syncing, so we save the transactions to redis for faster processing
        // Otherwise, we save the transactions to the database as this is a backfill
        syncOptions?.skipTransactions
          ? 0
          : blocks.fromBlock - blocks.toBlock === 0
          ? _saveBlockTransactionsToRedis(block)
          : _saveBlockTransactions(block),
      ]);
    }),
  ]);

  let enhancedEvents = logs
    .map((log) => {
      try {
        const block = blockData.find((b) => b.hash === log.blockHash);
        if (!block) {
          throw new Error(`Block ${log.blockHash} not found with RPC provider`);
        }
        const txData = block.transactions.find((tx) => tx.hash === log.transactionHash);

        if (!txData) {
          if (log.transactionHash === HashZero) {
            return [];
          }

          throw new Error(`Transaction ${log.transactionHash} not found in block ${block}`);
        }

        const baseEventParams = parseEvent(log, block.timestamp, 1, txData);
        return availableEventData
          .filter(
            ({ kind, addresses, numTopics, topic }) =>
              log.topics[0] === topic &&
              log.topics.length === numTopics &&
              (config.indexAllErc20 && kind === "erc20"
                ? true
                : addresses
                ? addresses[log.address.toLowerCase()]
                : true)
          )
          .map((eventData) => ({
            kind: eventData.kind,
            subKind: eventData.subKind,
            baseEventParams,
            log,
          }));
      } catch (error) {
        logger.error("sync-events-v2", `Failed to handle events (syncEvents): ${error}`);
        throw error;
      }
    })
    .flat();

  enhancedEvents = enhancedEvents.filter((e) => e) as EnhancedEvent[];

  // Process the retrieved events
  const eventsBatches = extractEventsBatches(enhancedEvents as EnhancedEvent[]);

  const startProcessLogs = Date.now();

  const processEventsLatencies = await processEventsBatchV2(eventsBatches, syncOptions);

  const endProcessLogs = Date.now();

  const endSyncTime = Date.now();

  const transactionCount = blockData.reduce((acc, b) => acc + b.transactions.length, 0);

  logger.info(
    "sync-events-timing-v2",
    JSON.stringify({
      message: `Events realtime syncing blocks ${blocks.fromBlock} to ${blocks.toBlock}`,
      blockRange: [blocks.fromBlock, blocks.toBlock],
      syncTime: endSyncTime - startSyncTime,
      // find the longest block sync time - the start sync time
      blockSyncTime: Math.max(...saveDataTimes.map((t) => t[0]?.endSaveBlocksTime)) - startSyncTime,
      logs: {
        count: logs.length,
        eventCount: enhancedEvents.length,
        getLogsTime,
        processLogs: endProcessLogs - startProcessLogs,
      },
      blocks: {
        count: 1,
        getBlockTime: endGetBlockTime - startGetBlockTime,
        saveBlocksTime: saveDataTimes.reduce((acc, t) => acc + t[0]?.saveBlocksTime, 0),
        saveBlockTransactionsTime: saveDataTimes.reduce((acc, t) => acc + t[1], 0),
        blockMinedTimestamp:
          blockData.length > 0
            ? blockData[0].timestamp
            : blockData.map((b) => {
                return {
                  number: b.number,
                  timestamp: b.timestamp,
                };
              }),
        wsEventLatency:
          syncEventsData?.blockEventTimeReceived && blockData.length
            ? syncEventsData?.blockEventTimeReceived - blockData[0].timestamp
            : undefined,
        blockEventTimeReceived: syncEventsData?.blockEventTimeReceived,
        rabbitMqMessagePublishTime: syncEventsData?.rabbitMqMessagePublishTime,
        startJobTimestamp: startSyncTime,
        startJobLatency: syncEventsData?.blockEventTimeReceived
          ? Math.floor(startSyncTime / 1000) - syncEventsData.blockEventTimeReceived
          : null,
        getBlockTimestamp: endGetBlockTime,
      },
      transactions: {
        count: transactionCount,
        saveBlockTransactionsTime: saveDataTimes.reduce((acc, t) => acc + t[1], 0),
      },
      processEventsLatencies: processEventsLatencies,
    })
  );

  if (blocks.fromBlock - blocks.toBlock === 0) {
    await saveRedisTransactionsJob.addToQueue({ block: blocks.fromBlock });
  }

  if (!syncOptions?.backfill) {
    blockData.forEach(async (block) => {
      await blockCheckJob.addToQueue({ block: block.number, blockHash: block.hash }, 60);
      await blockCheckJob.addToQueue({ block: block.number, blockHash: block.hash }, 60 * 5);
    });

    // For some chains if not nftTransferEvents nor ftTransferEvents schedule 2 other sync attempts
    if (config.enableNoTransfersResync && transactionCount && logs.length === 0) {
      for (const block of blockData) {
        if (await acquireLock(`realtime-sync-no-transfers:${block.number}`, 60 * 60)) {
          await eventsSyncRealtimeJob.addToQueue(
            { block: block.number, blockEventTimeReceived: syncEventsData?.blockEventTimeReceived },
            5 * 1000,
            true
          );

          await eventsSyncRealtimeJob.addToQueue(
            { block: block.number, blockEventTimeReceived: syncEventsData?.blockEventTimeReceived },
            30 * 1000,
            true
          );
        }
      }
    }
  }
};

export const unsyncEvents = async (block: number, blockHash: string) => {
  await Promise.all([
    es.fills.removeEvents(block, blockHash),
    es.bulkCancels.removeEvents(block, blockHash),
    es.nonceCancels.removeEvents(block, blockHash),
    es.cancels.removeEvents(block, blockHash),
    es.ftTransfers.removeEvents(block, blockHash),
    es.nftApprovals.removeEvents(block, blockHash),
    es.nftTransfers.removeEvents(block, blockHash),
    removeUnsyncedEventsActivitiesJob.addToQueue(blockHash),
  ]);
};

export const checkForOrphanedBlock = async (block: number) => {
  // Check if block number / hash does not match up (orphaned block)
  const upstreamBlockHash = (await baseProvider.getBlock(block)).hash.toLowerCase();

  // get block from db that has number = block and hash != upstreamBlockHash
  const orphanedBlocks = await blocksModel.getBlockWithNumber(block, upstreamBlockHash);

  if (!orphanedBlocks) return;

  for (const orphanedBlock of orphanedBlocks) {
    logger.info(
      "events-sync-catchup",
      `Detected orphaned block ${block} with hash ${orphanedBlock.hash} (upstream hash ${upstreamBlockHash})`
    );

    // delete the orphaned block data
    await unsyncEvents(block, orphanedBlock.hash);

    // TODO: add block hash to transactions table and delete transactions associated to the orphaned block
    // await deleteBlockTransactions(block);

    // TODO: add block hash to contracts table, and delete contracts / tokens associated to the orphaned block

    // check if we have the orphaned block in redis
    const blockDataRedis = await redis.get(`block:${block}`);
    if (blockDataRedis && JSON.parse(blockDataRedis).hash === orphanedBlock.hash) {
      // if we have the orphaned block in redis, delete it
      await redis.del(`block:${block}`);
    }
    // delete the block data
    await blocksModel.deleteBlock(block, orphanedBlock.hash);

    // check if we have the new block in postgres (get block with number = block and hash != orphanedBlock.hash)
    const newBlock = await blocksModel.getBlockWithNumber(block, orphanedBlock.hash);

    if (!newBlock) {
      logger.info(
        "events-sync-catchup",
        `New block ${block} with hash ${upstreamBlockHash} not found in database, syncing block`
      );
      // resync the block
      await eventsSyncRealtimeJob.addToQueue({ block: block });
    }
  }
};

export const checkForMissingBlocks = async (block: number) => {
  // lets set the latest block to the block we are syncing if it is higher than the current latest block by 1. If it is higher than 1, we create a job to sync the missing blocks
  // if its lower than the current latest block, we dont update the latest block in redis, but we still sync the block (this is for when we are catching up on missed blocks, or when we are syncing a block that is older than the current latest block)
  const latestBlock = await redis.get("latest-block-realtime");

  if (latestBlock) {
    const latestBlockNumber = Number(latestBlock);

    if (block - latestBlockNumber > 1) {
      // if we are missing more than 1 block, we need to sync the missing blocks
      for (let i = latestBlockNumber + 1; i <= block; i++) {
        // Don't consider blocks before genesis as missing
        if (config.genesisBlock && i < config.genesisBlock) {
          continue;
        }

        if (!(await redis.exists(`${eventsSyncRealtimeJob.queueName}:${i}`))) {
          logger.debug(
            "sync-events-realtime",
            `Found missing block: ${i} latest block ${block} latestBlock ${latestBlockNumber}`
          );

          await eventsSyncRealtimeJob.addToQueue({ block: i });
        }
      }
    }
  } else {
    await redis.set("latest-block-realtime", block);
  }
};
