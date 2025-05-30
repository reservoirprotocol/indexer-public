import { logger } from "@/common/logger";
import { config } from "@/config/index";
import { publishWebsocketEvent } from "@/common/websocketPublisher";
import crypto from "crypto";
import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import { DbEvent } from "@/events-sync/storage/nft-transfer-events";
import { getContractData, publishKafkaEvent } from "@/jobs/websocket-events/utils";

export type TransferWebsocketEventsTriggerQueueJobPayload = {
  data: TransferWebsocketEventInfo;
};

const changedMapping = {};

export class TransferWebsocketEventsTriggerQueueJob extends AbstractRabbitMqJobHandler {
  queueName = "transfer-websocket-events-trigger-queue";
  maxRetries = 10;
  concurrency = 10;
  timeout = 60000;
  backoff = {
    type: "exponential",
    delay: 1000,
  } as BackoffStrategy;
  disableErrorLogs = true;

  public async process(payload: TransferWebsocketEventsTriggerQueueJobPayload) {
    const { data } = payload;

    const changed = [];
    let eventType = "";

    if (data.after.is_deleted) eventType = "transfer.deleted";
    else if (data.trigger === "insert") eventType = "transfer.created";
    else if (data.trigger === "update") {
      eventType = "transfer.updated";
      if (data.before) {
        for (const key in changedMapping) {
          if (data.before[key as keyof TransferInfo] !== data.after[key as keyof TransferInfo]) {
            changed.push(changedMapping[key as keyof typeof changedMapping]);
          }
        }

        if (!changed.length) {
          for (const key in data.after) {
            const beforeValue = data.before[key as keyof TransferInfo];
            const afterValue = data.after[key as keyof TransferInfo];

            if (beforeValue !== afterValue) {
              changed.push(key as keyof TransferInfo);
            }
          }

          if (changed.length <= 1) {
            logger.debug(
              this.queueName,
              JSON.stringify({
                message: `No changes detected for transfer. contract=${data.after.address}, tokenId=${data.after.token_id}`,
                data,
                beforeJson: JSON.stringify(data.before),
                afterJson: JSON.stringify(data.after),
                changed,
                changedJson: JSON.stringify(changed),
                hasChanged: changed.length > 0,
              })
            );
          }

          return;
        }
      }
    }

    const contractData = await getContractData(data.after.address);
    const retryCount = Number(this.rabbitMqMessage?.retryCount);

    if (!contractData?.kind && retryCount < this.maxRetries) {
      throw new Error(`Contract kind not found.`);
    }

    const result = {
      id: crypto
        .createHash("sha256")
        .update(`${data.after.tx_hash}${data.after.log_index}${data.after.batch_index}`)
        .digest("hex"),
      token: {
        contract: data.after.address,
        tokenId: data.after.token_id,
        kind: contractData?.kind ?? undefined,
      },
      from: data.after.from,
      to: data.after.to,
      amount: data.after.amount,
      block: data.after.block,
      txHash: data.after.tx_hash,
      logIndex: data.after.log_index,
      batchIndex: data.after.batch_index,
      isAirdrop: data.after.kind ? (data.after.kind === "airdrop" ? true : false) : null,
      timestamp: data.after.timestamp,
      createdAt: new Date(data.after.created_at).toISOString(),
      updatedAt: new Date(data.after.updated_at).toISOString(),
    };

    const event = {
      event: eventType,
      data: result,
    };

    await publishWebsocketEvent({
      ...event,
      tags: {
        address: result.token.contract,
        from: result.from,
        to: result.to,
      },
      offset: data.offset,
    });

    await publishKafkaEvent(event);
  }

  public async addToQueue(events: TransferWebsocketEventsTriggerQueueJobPayload[]) {
    if (!config.doWebsocketServerWork) {
      return;
    }

    await this.sendBatch(
      events.map((event) => ({
        payload: event,
      }))
    );
  }
}

export type EventInfo = {
  data: TransferWebsocketEventInfo;
};

interface TransferInfo {
  address: string;
  block: string;
  tx_hash: string;
  tx_index: string;
  log_index: string;
  batch_index: string;
  timestamp: string;
  from: string;
  to: string;
  token_id: string;
  amount: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  kind: DbEvent["kind"] | null;
}

export type TransferWebsocketEventInfo = {
  before: TransferInfo;
  after: TransferInfo;
  trigger: "insert" | "update" | "delete";
  offset: string;
};

export const transferWebsocketEventsTriggerQueueJob = new TransferWebsocketEventsTriggerQueueJob();
