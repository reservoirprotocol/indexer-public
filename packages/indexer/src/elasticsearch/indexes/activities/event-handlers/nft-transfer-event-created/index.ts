/* eslint-disable @typescript-eslint/no-explicit-any */
import _ from "lodash";

import { fromBuffer, toBuffer } from "@/common/utils";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";

import {
  ActivityDocument,
  ActivityType,
  BuildActivityData,
} from "@/elasticsearch/indexes/activities/base";
import { getActivityHash } from "@/elasticsearch/indexes/activities/utils";
import {
  BaseActivityEventHandler,
  NftTransferEventInfo,
} from "@/elasticsearch/indexes/activities/event-handlers/base";
import { getNetworkSettings } from "@/config/network";

export class NftTransferEventCreatedEventHandler extends BaseActivityEventHandler {
  public txHash: string;
  public logIndex: number;
  public batchIndex: number;

  constructor(txHash: string, logIndex: number, batchIndex: number) {
    super();

    this.txHash = txHash;
    this.logIndex = logIndex;
    this.batchIndex = batchIndex;
  }

  async generateActivity(): Promise<ActivityDocument | null> {
    const data = await idb.oneOrNone(
      `
                ${NftTransferEventCreatedEventHandler.buildBaseQuery()}
                WHERE tx_hash = $/txHash/
                AND log_index = $/logIndex/
                AND batch_index = $/batchIndex/
                LIMIT 1;  
                `,
      {
        txHash: toBuffer(this.txHash),
        logIndex: this.logIndex.toString(),
        batchIndex: this.batchIndex.toString(),
      }
    );

    if (!data) {
      logger.warn(
        "NftTransferEventCreatedEventHandler",
        `failed to generate elastic activity activity. txHash=${this.txHash}, logIndex=${this.logIndex}, logIndex=${this.logIndex}`
      );

      return null;
    }

    return this.buildDocument(data);
  }

  getActivityType(data: BuildActivityData): ActivityType {
    return getNetworkSettings().mintAddresses.includes(fromBuffer(data.from))
      ? ActivityType.nftMint
      : ActivityType.nftTransfer;
  }

  getActivityId(data: BuildActivityData): string {
    return getActivityHash(
      this.getActivityType(data),
      this.txHash,
      this.logIndex.toString(),
      this.batchIndex.toString()
    );
  }

  public static buildBaseQuery() {
    return `
                SELECT
                  address AS "contract",
                  token_id,
                  "from",
                  "to",
                  amount,
                  tx_hash AS "event_tx_hash",
                  timestamp AS "event_timestamp",
                  block_hash AS "event_block_hash",
                  log_index AS "event_log_index",
                  batch_index AS "event_batch_index",
                  kind AS "event_transfer_kind",
                  extract(epoch from created_at) AS "created_ts",
                  t.*
                FROM nft_transfer_events
                LEFT JOIN LATERAL (
                    SELECT
                        tokens.name AS "token_name",
                        tokens.image AS "token_image",
                        tokens.media AS "token_media",
                        tokens.is_spam AS "token_is_spam",
                        tokens.nsfw_status AS "token_nsfw_status",
                        collections.is_spam AS "collection_is_spam",
                        collections.nsfw_status AS "collection_nsfw_status",
                        collections.id AS "collection_id",
                        collections.name AS "collection_name",
                        (collections.metadata ->> 'imageUrl')::TEXT AS "collection_image",
                        collections.image_version AS "collection_image_version",
                        (CASE WHEN collection_mints.kind = 'public' AND collection_mints.status = 'open' THEN TRUE ELSE FALSE END) AS "event_collection_is_minting",
                        collection_mints.price AS "event_collection_mint_price",
                        collection_mint_standards.standard AS "collection_mint_standard"
                    FROM tokens
                    JOIN collections on collections.id = tokens.collection_id
                    LEFT JOIN collection_mints ON collection_mints.collection_id = collections.id
                    LEFT JOIN collection_mint_standards ON collection_mint_standards.collection_id = collection_mints.collection_id
                    WHERE nft_transfer_events.address = tokens.contract
                    AND nft_transfer_events.token_id = tokens.token_id
                 ) t ON TRUE`;
  }

  public buildDocument(data: any): ActivityDocument {
    const activityDocument = super.buildDocument(data);

    activityDocument.nftTransferEvent = {
      isAirdrop: data.event_transfer_kind === "airdrop",
    };

    return activityDocument;
  }

  parseEvent(data: any) {
    data.timestamp = data.event_timestamp;
  }

  static async generateActivities(events: NftTransferEventInfo[]): Promise<ActivityDocument[]> {
    const activities: ActivityDocument[] = [];

    const eventsFilter = [];

    for (const event of events) {
      eventsFilter.push(
        `('${_.replace(event.txHash, "0x", "\\x")}', '${event.logIndex}', '${event.batchIndex}')`
      );
    }

    const results = await idb.manyOrNone(
      `
                ${NftTransferEventCreatedEventHandler.buildBaseQuery()}
                WHERE (tx_hash,log_index, batch_index) IN ($/eventsFilter:raw/);  
                `,
      { eventsFilter: _.join(eventsFilter, ",") }
    );

    for (const result of results) {
      try {
        const eventHandler = new NftTransferEventCreatedEventHandler(
          result.event_tx_hash,
          result.event_log_index,
          result.event_batch_index
        );

        const activity = eventHandler.buildDocument(result);

        activities.push(activity);
      } catch (error) {
        logger.error(
          "nft-transfer-event-created-event-handler",
          JSON.stringify({
            topic: "generate-activities",
            message: `Error build document. error=${error}`,
            result,
            error,
          })
        );
      }
    }

    return activities;
  }
}
