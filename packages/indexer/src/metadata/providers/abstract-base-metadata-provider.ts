import {
  customHandleCollection,
  customHandleToken,
  hasCustomCollectionHandler,
  hasCustomHandler,
} from "../custom";
import { CollectionMetadata, TokenMetadata } from "../types";
import {
  extendCollectionMetadata,
  extendMetadata,
  hasExtendHandler,
  overrideCollectionMetadata,
} from "../extend";
import { limitFieldSize } from "./utils";

import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import axios from "axios";
import { config } from "@/config/index";
import _ from "lodash";

export abstract class AbstractBaseMetadataProvider {
  abstract method: string;

  // Wrapper methods for internal methods, handles custom/extend logic so subclasses don't have to
  async getCollectionMetadata(contract: string, tokenId: string): Promise<CollectionMetadata> {
    // Handle universal extend/custom logic here
    if (hasCustomCollectionHandler(contract)) {
      const result = await customHandleCollection({
        contract,
        tokenId: tokenId,
      });
      return result;
    }

    let collectionMetadata = await this._getCollectionMetadata(contract, tokenId);

    // Handle extend logic here
    collectionMetadata = await extendCollectionMetadata(collectionMetadata, tokenId);

    // Handle metadata override here
    return overrideCollectionMetadata(collectionMetadata);
  }

  async getTokensMetadata(
    tokens: { contract: string; tokenId: string; uri?: string }[]
  ): Promise<TokenMetadata[]> {
    const customMetadata = await Promise.all(
      tokens.map(async (token) => {
        if (hasCustomHandler(token.contract)) {
          const result = await customHandleToken({
            contract: token.contract,
            tokenId: token.tokenId,
          });
          return result;
        }
        return null;
      })
    );

    // filter out nulls
    const filteredCustomMetadata = customMetadata.filter((metadata) => metadata !== null);

    // for tokens that don't have custom metadata, get from metadata-api
    const tokensWithoutCustomMetadata = tokens.filter((token) => {
      const hasCustomMetadata = filteredCustomMetadata.find((metadata) => {
        return metadata.contract === token.contract && metadata.tokenId === token.tokenId;
      });

      return !hasCustomMetadata;
    });

    let metadataFromProvider: TokenMetadata[] = [];

    if (tokensWithoutCustomMetadata.length > 0) {
      metadataFromProvider = await this._getTokensMetadata(tokensWithoutCustomMetadata);
    }

    // merge custom metadata with metadata-api metadata
    const allMetadata: TokenMetadata[] = [...metadataFromProvider, ...filteredCustomMetadata];
    // extend metadata
    const extendedMetadata = await Promise.all(
      allMetadata.map(async (metadata) => {
        logger.log(
          config.debugMetadataIndexingCollections.includes(metadata.contract) ? "info" : "debug",
          "getTokensMetadata",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `_getTokensMetadata. contract=${metadata.contract}, tokenId=${metadata.tokenId}, method=${this.method}`,
            metadata: JSON.stringify(metadata),
            debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
              metadata.contract
            ),
          })
        );

        if (hasExtendHandler(metadata.contract)) {
          return extendMetadata(metadata);
        }

        return metadata;
      })
    );

    // get mimetype for each image/media/metadata url
    await Promise.all(
      extendedMetadata.map(async (metadata) => {
        try {
          if (
            metadata.imageUrl &&
            (!metadata.imageUrl.startsWith("data:") || [690, 17069].includes(config.chainId)) &&
            !metadata.imageMimeType
          ) {
            const _getImageMimeTypeStart = Date.now();

            metadata.imageMimeType = await this._getImageMimeType(
              metadata.imageUrl,
              metadata.contract,
              metadata.tokenId
            );

            logger.log(
              config.debugMetadataIndexingCollections.includes(metadata.contract)
                ? "info"
                : "debug",
              "getTokensMetadata",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `_getImageMimeType - imageUrl. contract=${metadata.contract}, tokenId=${metadata.tokenId}, method=${this.method}, imageMimeType=${metadata.imageMimeType}`,
                metadata: JSON.stringify(metadata),
                _getImageMimeTypeStartLatency: Date.now() - _getImageMimeTypeStart,
                debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
                  metadata.contract
                ),
              })
            );

            if (metadata.contract === "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d") {
              metadata.imageMimeType = "image/png";
            }

            if (!metadata.imageMimeType) {
              logger.warn(
                "getTokensMetadata",
                JSON.stringify({
                  topic: "tokenMetadataIndexing",
                  message: `Missing image mime type. contract=${metadata.contract}, tokenId=${metadata.tokenId}, imageUrl=${metadata.imageUrl}`,
                  metadata: JSON.stringify(metadata),
                  method: this.method,
                  debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
                    metadata.contract
                  ),
                })
              );
            }
          }

          if (
            metadata.mediaUrl &&
            (!metadata.mediaUrl.startsWith("data:") || [690, 17069].includes(config.chainId)) &&
            !metadata.mediaMimeType
          ) {
            const _getImageMimeTypeStart = Date.now();

            metadata.mediaMimeType = await this._getImageMimeType(
              metadata.mediaUrl,
              metadata.contract,
              metadata.tokenId
            );

            logger.log(
              config.debugMetadataIndexingCollections.includes(metadata.contract)
                ? "info"
                : "debug",
              "getTokensMetadata",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `_getImageMimeType - mediaUrl. contract=${metadata.contract}, tokenId=${metadata.tokenId}, method=${this.method}, mediaMimeType=${metadata.mediaMimeType}`,
                metadata: JSON.stringify(metadata),
                debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
                  metadata.contract
                ),
              })
            );

            if (!metadata.mediaMimeType) {
              logger.warn(
                "getTokensMetadata",
                JSON.stringify({
                  topic: "tokenMetadataIndexing",
                  message: `Missing media mime type. contract=${metadata.contract}, tokenId=${metadata.tokenId}, mediaUrl=${metadata.mediaUrl}`,
                  metadata: JSON.stringify(metadata),
                  method: this.method,
                  _getImageMimeTypeStartLatency: Date.now() - _getImageMimeTypeStart,
                  debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
                    metadata.contract
                  ),
                })
              );
            }
          }

          const imageMimeTypesPrefixes = ["image/", "application/octet-stream"];

          // if the imageMimeType is not an "image" mime type, we want to set imageUrl to null and mediaUrl to imageUrl
          if (
            metadata.imageUrl &&
            metadata.imageMimeType &&
            !imageMimeTypesPrefixes.some((imageMimeTypesPrefix) =>
              metadata.imageMimeType.startsWith(imageMimeTypesPrefix)
            )
          ) {
            metadata.mediaUrl = metadata.imageUrl;
            metadata.mediaMimeType = metadata.imageMimeType;
            metadata.imageUrl = null;
            metadata.imageMimeType = undefined;
          }
        } catch (error) {
          logger.error(
            "getTokensMetadata",
            JSON.stringify({
              message: `extendedMetadata error. contract=${metadata.contract}, tokenId=${metadata.tokenId}, error=${error}`,
              metadata,
              error,
            })
          );

          throw error;
        }
      })
    );

    // Remove originalMetadata, the amount of data here can be in the MBs and ideally it won't be moved around to
    // rabbit and eventually written to the DB as there's no use for it at the moment besides for artblocks
    extendedMetadata.map((m) => _.unset(m, "originalMetadata"));

    return extendedMetadata;
  }

  async _getImageMimeType(url: string, contract: string, tokenId: string): Promise<string> {
    if (url.endsWith(".png")) {
      return "image/png";
    }

    if (url.endsWith(".jpg") || url.endsWith(".jpeg")) {
      return "image/jpeg";
    }

    if (url.endsWith(".gif")) {
      return "image/gif";
    }

    if (url.endsWith(".svg")) {
      return "image/svg+xml";
    }

    if (url.endsWith(".webp")) {
      return "image/webp";
    }

    if (url.endsWith(".mp4")) {
      return "video/mp4";
    }

    if (url.endsWith(".mp3")) {
      return "audio/mp3";
    }

    if (url.endsWith(".wav")) {
      return "audio/wav";
    }

    if (url.endsWith(".m4a")) {
      return "audio/m4a";
    }

    if (url.startsWith("data:image/svg+xml")) {
      return "image/svg+xml";
    }

    if (!url.startsWith("http")) {
      return "";
    }

    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal,
      });

      if (response.ok) {
        return response.headers.get("content-type") || "";
      }

      if (response.status === 404 || response.status === 422) {
        return "";
      }

      logger.log(
        config.debugMetadataIndexingCollections.includes(contract) ? "warn" : "debug",
        "_getImageMimeType",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `fetchNotOk. status=${response.status}, contract=${contract}, tokenId=${tokenId}, url=${url}`,
          contract,
          tokenId,
          debugMetadataIndexingCollection: true,
        })
      );
    } catch (e) {
      logger.log(
        config.debugMetadataIndexingCollections.includes(contract) ? "error" : "debug",
        "_getImageMimeType",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `fetchError. contract=${contract}, tokenId=${tokenId}, url=${url}, error=${JSON.stringify(
            e
          )}`,
          contract,
          tokenId,
          debugMetadataIndexingCollection: true,
        })
      );
    } finally {
      clearTimeout(timeoutId);
    }

    let _url = url;

    const isIpfsIo = _url.includes("/ipfs.io/");

    if (isIpfsIo && config.ipfsGatewayDomain && config.forceIpfsGateway) {
      _url = _url.replace("ipfs.io", config.ipfsGatewayDomain);
    }

    let imageMimeType = await redis.get(`imageMimeType:${_url}`);

    if (!imageMimeType) {
      imageMimeType = await axios
        .head(_url, { timeout: 10000 })
        .then((res) => {
          if (!res.headers["content-type"]) {
            logger.debug(
              "_getImageMimeType",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `Missing content type. contract=${contract}, tokenId=${tokenId}, url=${_url}`,
                debugMetadataIndexingCollection:
                  config.debugMetadataIndexingCollections.includes(contract),
                headers: JSON.stringify(res.headers),
              })
            );
          }

          return res.headers["content-type"];
        })
        .catch((error) => {
          const fallbackToIpfsGateway = config.ipfsGatewayDomain && _url.includes("//ipfs.io");

          if (fallbackToIpfsGateway) {
            const ipfsGatewayUrl = _url.replace("ipfs.io", config.ipfsGatewayDomain);

            return axios
              .head(ipfsGatewayUrl)
              .then((res) => {
                if (!res.headers["content-type"]) {
                  logger.debug(
                    "_getImageMimeType",
                    JSON.stringify({
                      topic: "tokenMetadataIndexing",
                      message: `Missing content type - fallback. contract=${contract}, tokenId=${tokenId}, url=${_url}, ipfsGatewayUrl=${ipfsGatewayUrl}`,
                      debugMetadataIndexingCollection:
                        config.debugMetadataIndexingCollections.includes(contract),
                      headers: JSON.stringify(res.headers),
                    })
                  );
                }

                return res.headers["content-type"];
              })
              .catch((fallbackError) => {
                logger.warn(
                  "_getImageMimeType",
                  JSON.stringify({
                    topic: "tokenMetadataIndexing",
                    message: `Fallback Error. contract=${contract}, tokenId=${tokenId}, url=${_url}, ipfsGatewayUrl=${ipfsGatewayUrl}`,
                    error: JSON.stringify(error),
                    fallbackError: JSON.stringify(fallbackError),
                    debugMetadataIndexingCollection:
                      config.debugMetadataIndexingCollections.includes(contract),
                  })
                );
              });
          } else {
            logger.warn(
              "_getImageMimeType",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `Error. contract=${contract}, tokenId=${tokenId}, url=${_url}, error=${error}`,
                error,
                debugMetadataIndexingCollection:
                  config.debugMetadataIndexingCollections.includes(contract),
              })
            );
          }
        });

      if (imageMimeType) {
        await redis.set(`imageMimeType:${_url}`, imageMimeType, "EX", 3600);
      }
    }

    return imageMimeType || "";
  }

  // Internal methods for subclasses
  protected abstract _getCollectionMetadata(
    contract: string,
    tokenId: string
  ): Promise<CollectionMetadata>;

  protected abstract _getTokensMetadata(
    tokens: { contract: string; tokenId: string }[]
  ): Promise<TokenMetadata[]>;

  // Parsers

  // eslint-disable-next-line
  protected abstract parseCollection(...args: any[]): CollectionMetadata;

  // eslint-disable-next-line
  protected abstract _parseToken(...args: any[]): TokenMetadata;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseToken(...args: any[]): TokenMetadata {
    const parsedMetadata = this._parseToken(...args);
    Object.keys(parsedMetadata).forEach((key) => {
      parsedMetadata[key as keyof TokenMetadata] = limitFieldSize(
        parsedMetadata[key as keyof TokenMetadata],
        key,
        parsedMetadata.contract,
        parsedMetadata.tokenId,
        this.method
      );
    });

    return parsedMetadata;
  }
}
