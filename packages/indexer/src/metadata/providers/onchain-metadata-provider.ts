/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from "@/config/index";
import { CollectionMetadata, TokenMetadata } from "../types";

import { metadataIndexingBaseProvider } from "@/common/provider";
import { defaultAbiCoder } from "ethers/lib/utils";
import { logger } from "@/common/logger";
import { ethers } from "ethers";
import {
  RequestWasThrottledError,
  normalizeLink,
  normalizeCollectionMetadata,
  TokenUriNotFoundError,
  TokenUriRequestTimeoutError,
  TokenUriRequestForbiddenError,
  handleTokenUriResponse,
  handleTokenUriErrorResponse,
} from "./utils";

import _ from "lodash";
import crypto from "crypto";

import { AbstractBaseMetadataProvider } from "./abstract-base-metadata-provider";
import { getChainName } from "@/config/network";
import axios from "axios";
import { redis } from "@/common/redis";
import { idb } from "@/common/db";
import { toBuffer } from "@/common/utils";
import { randomUUID } from "crypto";
import { customFetchTokenUriMetadata, hasCustomTokenUriMetadataHandler } from "@/metadata/custom";
import { Network } from "@reservoir0x/sdk/dist/utils";

const erc721Interface = new ethers.utils.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
]);

const erc1155Interface = new ethers.utils.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);

export class OnchainMetadataProvider extends AbstractBaseMetadataProvider {
  method = "onchain";

  // get metadata methods

  async _getTokensMetadata(
    tokens: { contract: string; tokenId: string; uri: string }[]
  ): Promise<TokenMetadata[]> {
    try {
      const resolvedMetadata = await Promise.all(
        tokens.map(async (token: any) => {
          const getTokenMetadataFromURIStart = Date.now();

          const [metadata, error] = await this.getTokenMetadataFromURI(
            token.uri,
            token.contract,
            token.tokenId
          );

          const getTokenMetadataFromURILatency = Date.now() - getTokenMetadataFromURIStart;

          logger.log(
            config.debugMetadataIndexingCollections.includes(token.contract) ? "info" : "debug",
            "_getTokensMetadata",
            JSON.stringify({
              topic: "tokenMetadataIndexing",
              message: `getTokenMetadataFromURI. contract=${token.contract}, tokenId=${token.tokenId}, uri=${token.uri}`,
              metadata: JSON.stringify(metadata),
              getTokenMetadataFromURILatency,
              error,
              isSuccess: !!metadata,
              debugMetadataIndexingCollection: config.debugMetadataIndexingCollections.includes(
                token.contract
              ),
            })
          );

          if (!metadata) {
            if (error === 429) {
              throw new RequestWasThrottledError("Request was throttled", 10);
            }

            if (error === 504) {
              throw new TokenUriRequestTimeoutError("Request timed out");
            }

            if (error === 404) {
              throw new TokenUriNotFoundError("Not found");
            }

            if (error === 403) {
              throw new TokenUriRequestForbiddenError("Not Allowed");
            }

            throw new Error(error || "Unknown error");
          }

          return {
            ...metadata,
            ...token,
          };
        })
      );

      return resolvedMetadata.map((token) => {
        return this.parseToken(token);
      });
    } catch (error) {
      if (config.debugMetadataIndexingCollections.includes(tokens[0].contract)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "_getTokensMetadata",
            message: `Could not fetch tokens. error=${error}`,
            tokens,
            error,
          })
        );
      }

      throw error;
    }
  }

  async _getTokensMetadataUri(tokens: { contract: string; tokenId: string }[]): Promise<
    {
      contract: string;
      tokenId: string;
      uri: string | null;
      error?: string;
    }[]
  > {
    const tokenData: {
      contract: string;
      tokenId: string;
      standard?: string;
      requestId?: string;
    }[] = tokens;

    // Detect token standard, batch contract addresses together to call once per contract
    const contracts: string[] = [];
    tokenData.forEach((token) => {
      if (!contracts.includes(token.contract)) {
        contracts.push(token.contract);
      }
    });

    const standards = await Promise.all(
      contracts.map(async (contract) => {
        const standard = await this.detectTokenStandard(contract);
        return {
          contract,
          standard,
        };
      })
    );

    // Map the token to the standard
    tokenData.forEach((token) => {
      const standard = standards.find((standard) => standard.contract === token.contract);
      if (standard) token.standard = standard.standard;
    });

    // We need to have some type of hash map to map the tokenid + contract to the tokenURI
    const idToToken: any = {};
    tokenData.forEach((token) => {
      token.requestId = randomUUID();
      idToToken[token.requestId] = token;
    });

    let encodedTokens = tokenData.map((token) => {
      if (token.standard === "ERC721") {
        return this.encodeTokenERC721(token);
      } else if (token.standard === "ERC1155") {
        return this.encodeTokenERC1155(token);
      } else {
        return null;
      }
    });

    encodedTokens = encodedTokens.filter((token) => token !== null);
    if (encodedTokens.length === 0) {
      // return array of tokens with error
      return tokenData.map((token) => {
        return {
          contract: token.contract,
          tokenId: token.tokenId,
          uri: null,
          error: "Unsupported token standard",
        };
      });
    }

    const [batch, error] = await this.sendBatch(encodedTokens);

    if (error) {
      if (
        config.debugMetadataIndexingCollections.some((collection) =>
          tokenData.map((token) => token.contract).includes(collection)
        )
      ) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `fetchTokens sendBatch error. errorStatus=${error.status}`,
            error,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      if (error.status === 429) {
        throw new RequestWasThrottledError(error.message, 10);
      }

      throw error;
    }

    const resolvedURIs = await Promise.all(
      batch.map(async (token: any) => {
        try {
          let uri = defaultAbiCoder.decode(["string"], token.result)[0];

          if (config.debugMetadataIndexingCollections.includes(idToToken[token.id].contract)) {
            logger.info(
              "onchain-fetcher",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `_getTokensMetadataUri. Debug uri.  contract=${
                  idToToken[token.id].contract
                }, tokenId=${idToToken[token.id].tokenId}`,
                contract: idToToken[token.id].contract,
                tokenId: idToToken[token.id].tokenId,
                uri,
                token,
                debugMetadataIndexingCollection: true,
              })
            );
          }

          if (!uri || uri === "") {
            return {
              contract: idToToken[token.id].contract,
              tokenId: idToToken[token.id].tokenId,
              uri: null,
              error: "Unable to decode tokenURI from contract",
            };
          }

          if (uri.endsWith("0x{id}")) {
            if (uri.startsWith("https://api.opensea.io/")) {
              uri = uri.replace("0x{id}", idToToken[token.id].tokenId);
            }

            if (uri.startsWith("ens-metadata-service.appspot.com/")) {
              uri = `https://metadata.ens.domains/${getChainName()}/${
                idToToken[token.id].contract
              }/${idToToken[token.id].tokenId}`;
            }
          } else if (uri.endsWith("/{id}") || uri.endsWith("/{id}/metadata")) {
            uri = uri.replace(
              "{id}",
              Number(idToToken[token.id].tokenId).toString(16).padStart(64, "0")
            );
          } else if (uri.endsWith("/{id}.json")) {
            if (config.chainId !== Network.Xai) {
              logger.info(
                "debug-token-uri",
                JSON.stringify({
                  topic: "debugTokenUri",
                  message: `_getTokensMetadataUri - Debug {id}.json. contract=${
                    idToToken[token.id].contract
                  }, tokenId=${idToToken[token.id].tokenId}, uri=${uri}`,
                  contract: idToToken[token.id].contract,
                  tokenId: idToToken[token.id].tokenId,
                  uriBase16: uri.replace(
                    "{id}",
                    Number(idToToken[token.id].tokenId).toString(16).padStart(64, "0")
                  ),
                  uriBase10: uri.replace("{id}", idToToken[token.id].tokenId),
                  standard: standards.find(
                    (standard) => standard.contract === idToToken[token.id].contract
                  ),
                })
              );
            }

            uri = uri.replace("{id}", idToToken[token.id].tokenId);
          } else if (uri.endsWith("tokenId={id}")) {
            logger.info(
              "debug-token-uri",
              JSON.stringify({
                topic: "debugTokenUri",
                message: `_getTokensMetadataUri - Debug tokenId={id}. contract=${
                  idToToken[token.id].contract
                }, tokenId=${idToToken[token.id].tokenId}, uri=${uri}`,
                contract: idToToken[token.id].contract,
                tokenId: idToToken[token.id].tokenId,
                uriBase16: uri.replace(
                  "{id}",
                  Number(idToToken[token.id].tokenId).toString(16).padStart(64, "0")
                ),
                uriBase10: uri.replace("{id}", idToToken[token.id].tokenId),
                standard: standards.find(
                  (standard) => standard.contract === idToToken[token.id].contract
                ),
              })
            );

            uri = uri.replace("{id}", idToToken[token.id].tokenId);
          } else if (uri.includes("{id}")) {
            logger.info(
              "debug-token-uri",
              JSON.stringify({
                topic: "debugTokenUri",
                message: `_getTokensMetadataUri - Debug {id}. contract=${
                  idToToken[token.id].contract
                }, tokenId=${idToToken[token.id].tokenId}, uri=${uri}`,
                contract: idToToken[token.id].contract,
                tokenId: idToToken[token.id].tokenId,
                uriBase16: uri.replace(
                  "{id}",
                  Number(idToToken[token.id].tokenId).toString(16).padStart(64, "0")
                ),
                uriBase10: uri.replace("{id}", idToToken[token.id].tokenId),
                standard: standards.find(
                  (standard) => standard.contract === idToToken[token.id].contract
                ),
              })
            );
          }

          return {
            contract: idToToken[token.id].contract,
            tokenId: idToToken[token.id].tokenId,
            uri,
          };
        } catch (error) {
          if (config.debugMetadataIndexingCollections.includes(idToToken[token.id].contract)) {
            logger.warn(
              "onchain-fetcher",
              JSON.stringify({
                topic: "tokenMetadataIndexing",
                message: `_getTokensMetadataUri - Could not fetch tokenURI. contract=${
                  idToToken[token.id].contract
                }, tokenId=${idToToken[token.id].tokenId}, error=${error}`,
                contract: idToToken[token.id].contract,
                tokenId: idToToken[token.id].tokenId,
                error,
                debugMetadataIndexingCollection: true,
              })
            );
          }

          return {
            contract: idToToken[token.id].contract,
            tokenId: idToToken[token.id].tokenId,
            uri: null,
            error: "Unable to decode tokenURI from contract",
          };
        }
      })
    );

    // add tokens that are in the batch but not in the response
    // (this happens when the token doesn't exist)
    const missingTokens = tokenData.filter(
      (token) =>
        !resolvedURIs.find(
          (uri) => uri.tokenId === token.tokenId && uri.contract === token.contract
        )
    );
    missingTokens.forEach((token) => {
      resolvedURIs.push({
        contract: token.contract,
        tokenId: token.tokenId,
        uri: null,
        error: "Token not found",
      });
    });

    return resolvedURIs;
  }

  async _getCollectionMetadata(contract: string): Promise<CollectionMetadata> {
    try {
      const collection = await this.getContractURI(contract);
      let collectionName = collection?.name ?? null;

      // Fallback for collection name if collection metadata not found
      if (!collectionName) {
        collectionName = (await this.getContractName(contract)) ?? contract;
      }

      return this.parseCollection({
        ...collection,
        contract,
        name: collectionName,
      });
    } catch (error) {
      if (config.debugMetadataIndexingCollections.includes(contract)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `_getCollectionMetadata. Could not fetch collection.  contract=${contract}, error=${error}`,
            contract,
            error,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      return {
        id: contract,
        slug: null,
        name: contract,
        community: null,
        metadata: null,
        contract,
        tokenIdRange: null,
        tokenSetId: `contract:${contract}`,
        isFallback: true,
      };
    }
  }

  // parsers

  _parseToken(metadata: any): TokenMetadata {
    let attributes = metadata?.attributes || metadata?.properties || [];

    if (typeof attributes === "string") {
      attributes = JSON.parse(attributes);
    }

    if (!Array.isArray(attributes)) {
      attributes = Object.keys(attributes).map((key) => {
        if (typeof attributes[key] === "object") {
          return {
            trait_type: key,
            value: attributes[key],
          };
        } else {
          return {
            trait_type: key,
            value: attributes[key],
          };
        }
      });
    }

    const imageUrl =
      normalizeLink(metadata?.image) ||
      normalizeLink(metadata?.image_url) ||
      normalizeLink(metadata?.imageUrl) ||
      normalizeLink(metadata?.image_data) ||
      null;

    const mediaUrl =
      normalizeLink(metadata?.animation_url) || normalizeLink(metadata?.media?.uri) || null;

    const parsedMetadata = {
      contract: metadata.contract,
      slug: null,
      tokenURI: metadata.uri,
      tokenId: metadata.tokenId,
      collection: _.toLower(metadata.contract),
      name: metadata?.name || metadata?.tokenName || null,
      flagged: null,
      description: _.isArray(metadata?.description)
        ? metadata.description[0]
        : metadata.description || null,
      imageUrl,
      imageOriginalUrl: metadata?.image || metadata?.image_url || null,
      animationOriginalUrl: metadata?.animation_url || metadata?.media?.uri || null,
      mediaUrl,
      metadataOriginalUrl: this.parseIPFSURI(metadata.uri),
      attributes: attributes.map((trait: any) => ({
        key: trait.trait_type || "property",
        value: trait.value,
        kind: typeof trait.value == "number" ? "number" : "string",
        rank: 1,
      })),
      decimals: metadata?.decimals ? parseInt(metadata.decimals) : undefined,
      metadataHash:
        metadata &&
        crypto
          .createHash("sha256")
          .update(JSON.stringify(metadata, Object.keys(metadata).sort()))
          .digest("hex"),
      originalMetadata: metadata,
    };

    if (config.debugMetadataIndexingCollections.includes(metadata.contract)) {
      logger.info(
        "onchain-fetcher",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `_parseToken. contract=${metadata.contract}, tokenId=${metadata.tokenId}`,
          debugMetadataIndexingCollection: true,
          metadata: JSON.stringify(metadata),
          parsedMetadata: JSON.stringify(parsedMetadata),
        })
      );
    }

    return parsedMetadata;
  }

  parseCollection(metadata: any): CollectionMetadata {
    return {
      id: metadata.contract,
      slug: null,
      community: null,
      name: metadata?.name || null,
      metadata: normalizeCollectionMetadata(metadata),
      contract: metadata.contract,
      tokenSetId: `contract:${metadata.contract}`,
      tokenIdRange: null,
    };
  }

  // helpers

  async detectTokenStandard(contractAddress: string) {
    let erc721Supported = false;
    let erc1155Supported = false;

    try {
      let contractKind = await redis.get(`contract-kind:${contractAddress}`);

      if (!contractKind) {
        const result = await idb.oneOrNone(
          `
          SELECT
            con.kind
          FROM contracts con
          WHERE con.address = $/contract/
        `,
          {
            contract: toBuffer(contractAddress),
          }
        );

        contractKind = result?.kind;

        if (contractKind) {
          await redis.set(`contract-kind:${contractAddress}`, contractKind, "EX", 3600);
        }
      }

      erc721Supported = contractKind === "erc721" || contractKind === "erc721-like";
      erc1155Supported = contractKind === "erc1155";

      if (!erc721Supported && !erc1155Supported) {
        const contract = new ethers.Contract(
          contractAddress,
          [...erc721Interface.fragments, ...erc1155Interface.fragments],
          metadataIndexingBaseProvider
        );

        erc721Supported = await contract.supportsInterface("0x80ac58cd");

        if (!erc721Supported) {
          erc1155Supported = await contract.supportsInterface("0xd9b67a26");
        }
      }

      if (erc721Supported) {
        return "ERC721";
      }

      if (erc1155Supported) {
        return "ERC1155";
      }
    } catch (error) {
      if (config.debugMetadataIndexingCollections.includes(contractAddress)) {
        logger.error(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `detectTokenStandard error. contractAddress=${contractAddress}, error=${error}`,
            debugMetadataIndexingCollection: true,
          })
        );
      }
    }

    return "Unknown";
  }

  encodeTokenERC721(token: any) {
    try {
      const iface = new ethers.utils.Interface([
        {
          name: "tokenURI",
          type: "function",
          stateMutability: "view",
          inputs: [
            {
              type: "uint256",
              name: "tokenId",
            },
          ],
        },
      ]);

      return {
        id: token.requestId,
        encodedTokenID: iface.encodeFunctionData("tokenURI", [token.tokenId]),
        contract: token.contract,
      };
    } catch (error) {
      if (config.debugMetadataIndexingCollections.includes(token.contract)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `encodeTokenERC721 error. contractAddress=${token.contract}, tokenId=${token.tokenId}, error=${error}`,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      return null;
    }
  }

  encodeTokenERC1155(token: any) {
    try {
      const iface = new ethers.utils.Interface([
        {
          name: "uri",
          type: "function",
          stateMutability: "view",
          inputs: [
            {
              type: "uint256",
              name: "tokenId",
            },
          ],
        },
      ]);

      return {
        id: token.requestId,
        encodedTokenID: iface.encodeFunctionData("uri", [token.tokenId]),
        contract: token.contract,
      };
    } catch (error) {
      if (config.debugMetadataIndexingCollections.includes(token.contract)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `encodeTokenERC1155 error. contractAddress=${token.contract}, tokenId=${token.tokenId}, error=${error}`,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      return null;
    }
  }

  getRPC() {
    return config.baseNetworkMetadataIndexingUrl;
  }

  async getContractName(contractAddress: string) {
    try {
      const contract = new ethers.Contract(
        contractAddress,
        ["function name() view returns (string)"],
        metadataIndexingBaseProvider
      );
      const name = await contract.name();
      return name;
    } catch (e) {
      if (config.debugMetadataIndexingCollections.includes(contractAddress)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `getContractName error. contractAddress=${contractAddress}, error=${e}`,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      return null;
    }
  }

  async getContractURI(contractAddress: string) {
    try {
      const contract = new ethers.Contract(
        contractAddress,
        ["function contractURI() view returns (string)"],
        metadataIndexingBaseProvider
      );
      let uri = await contract.contractURI();

      uri = normalizeLink(uri, false);

      const isDataUri = uri.startsWith("data:application/json;base64,");

      if (isDataUri) {
        uri = uri.replace("data:application/json;base64,", "");
      }

      const json = isDataUri
        ? JSON.parse(Buffer.from(uri, "base64").toString("utf-8"))
        : await fetch(uri, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
            // timeout: FETCH_TIMEOUT,
            // TODO: add proxy support to avoid rate limiting
            // agent:
          }).then((response) => response.json());

      return json;
    } catch (e) {
      if (config.debugMetadataIndexingCollections.includes(contractAddress)) {
        logger.warn(
          "onchain-fetcher",
          JSON.stringify({
            topic: "tokenMetadataIndexing",
            message: `getContractURI error. contractAddress:${contractAddress}, error:${e}`,
            debugMetadataIndexingCollection: true,
          })
        );
      }

      return null;
    }
  }

  createBatch(encodedTokens: any) {
    return encodedTokens.map((token: any) => {
      return {
        jsonrpc: "2.0",
        id: token.id,
        method: "eth_call",
        params: [
          {
            data: token.encodedTokenID,
            to: token.contract,
          },
          "latest",
        ],
      };
    });
  }

  async sendBatch(encodedTokens: any) {
    let response;
    try {
      response = await fetch(this.getRPC(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.createBatch(encodedTokens)),
        // timeout: FETCH_TIMEOUT,
        // TODO: add proxy support to avoid rate limiting
        // agent:
      });
      const body = await response.text();
      if (!response.ok) {
        return [
          null,
          {
            body: body,
            status: response.status,
          },
        ];
      }
      const json = JSON.parse(body);
      return [json, null];
    } catch (e: any) {
      logger.warn(
        "onchain-fetcher",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `sendBatch error. error:${JSON.stringify(e)}`,
        })
      );

      return [
        null,
        {
          message: e.message,
          status: response?.status,
        },
      ];
    }
  }

  parseIPFSURI(uri: string) {
    if (uri && uri?.startsWith("ipfs.io/")) {
      uri = uri.replace("ipfs.io/", "https://ipfs.io/");
    }

    if (uri && uri?.includes("ipfs://ipfs/")) {
      uri = uri.replace("ipfs://ipfs/", "https://ipfs.io/ipfs/");
    }

    if (uri && uri?.includes("ipfs://")) {
      uri = uri.replace("ipfs://", "https://ipfs.io/ipfs/");
    }

    if (uri && uri?.includes("gateway.pinata.cloud")) {
      uri = uri.replace("gateway.pinata.cloud", "ipfs.io");
    }

    if (uri && uri?.includes("alienworlds.pinata.cloud")) {
      uri = uri.replace("alienworlds.pinata.cloud", "ipfs.io");
    }

    if (uri && uri?.includes("metaid.zkbridge.com")) {
      uri = uri.replace("metaid.zkbridge.com", "ipfs.io");
    }

    if (uri && uri?.includes("rarible.mypinata.cloud")) {
      uri = uri.replace("rarible.mypinata.cloud", "ipfs.io");
    }

    if (uri && uri?.includes("ipfs.dweb.link")) {
      const dwebLinkMatch = uri?.match(/^(http)s?:\/\/(.*?)\.ipfs\.dweb\.link\/(.*?)$/);

      if (dwebLinkMatch) {
        uri = `https://ipfs.io/ipfs/${dwebLinkMatch[2]}/${dwebLinkMatch[3]}`;
      }
    }

    return uri;
  }

  async getTokenMetadataFromURI(uri: string, contract: string, tokenId: string) {
    try {
      uri = uri.trim();

      if (hasCustomTokenUriMetadataHandler(contract)) {
        return customFetchTokenUriMetadata(
          {
            contract,
            tokenId,
          },
          uri
        );
      }

      if (uri.startsWith("data:application/json;base64,")) {
        uri = uri.replace("data:application/json;base64,", "");
        return [JSON.parse(Buffer.from(uri, "base64").toString("utf-8")), null];
      } else if (uri.startsWith("data:application/json")) {
        // remove everything before the first comma
        uri = uri.substring(uri.indexOf(",") + 1);

        if (uri.startsWith("%7B") || uri.startsWith("%7b")) {
          uri = decodeURIComponent(uri);
        }

        return [JSON.parse(uri), null];
      }

      if (uri.startsWith("{") && uri.endsWith("}")) {
        try {
          return [JSON.parse(uri), null];
        } catch {
          return [null, "Invalid URI"];
        }
      }

      if (uri.startsWith("json:")) {
        uri = uri.replace("json:\n", "");
      }

      if (uri.startsWith("ar://")) {
        uri = uri.replace("ar://", "https://arweave.net/");
      }

      uri = this.parseIPFSURI(uri);

      if (!uri.startsWith("http")) {
        // if the uri is not a valid url, return null
        return [null, "Invalid URI"];
      }

      if (uri.includes("ipfs.io")) {
        return this.getIPFSURI(contract, tokenId, uri);
      }

      return axios
        .get(uri, {
          timeout: 5000,
          headers: {
            "Content-Type": "application/json",
          },
        })
        .then((res) => handleTokenUriResponse(contract, tokenId, res))
        .catch((error) =>
          handleTokenUriErrorResponse(contract, tokenId, error, "getTokenMetadataFromURI")
        );
    } catch (error) {
      logger.log(
        config.debugMetadataIndexingCollections.includes(contract) ? "warn" : "debug",
        "onchain-fetcher",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `getTokenMetadataFromURI error. contract=${contract}, tokenId=${tokenId}`,
          contract,
          tokenId,
          uri,
          error,
          debugMetadataIndexingCollection: true,
        })
      );

      return [null, (error as any).message];
    }
  }

  async getIPFSURI(contract: string, tokenId: string, uri: string) {
    const controller = new AbortController();
    const signal = controller.signal;
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(uri, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
        signal,
      });

      const body = await response.text();

      if (response.ok) {
        return [JSON.parse(body), null];
      }

      if (response.status === 404 || response.status === 422) {
        return [null, response.status];
      }

      logger.log(
        config.debugMetadataIndexingCollections.includes(contract) ? "warn" : "debug",
        "onchain-fetcher",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `handleTokenUri fetchNotOk. status=${response.status}, contract=${contract}, tokenId=${tokenId}, uri=${uri},`,
          contract,
          tokenId,
          debugMetadataIndexingCollection: true,
        })
      );
    } catch (e) {
      logger.log(
        config.debugMetadataIndexingCollections.includes(contract) ? "error" : "debug",
        "onchain-fetcher",
        JSON.stringify({
          topic: "tokenMetadataIndexing",
          message: `handleTokenUri fetchError. contract=${contract}, tokenId=${tokenId}, uri=${uri}, error=${JSON.stringify(
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

    if (config.ipfsGatewayDomain && config.forceIpfsGateway) {
      uri = uri.replace("ipfs.io", config.ipfsGatewayDomain);
    }

    return axios
      .get(uri, {
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
        },
      })
      .then((res) => handleTokenUriResponse(contract, tokenId, res))
      .catch((error) => {
        if (config.ipfsGatewayDomain && !config.forceIpfsGateway) {
          const ipfsGatewayUrl = uri.replace("ipfs.io", config.ipfsGatewayDomain);

          return axios
            .get(ipfsGatewayUrl, {
              timeout: 5000,
              headers: {
                "Content-Type": "application/json",
              },
            })
            .then((res) => handleTokenUriResponse(contract, tokenId, res))
            .catch((fallbackError) =>
              handleTokenUriErrorResponse(contract, tokenId, fallbackError, "fallbackError")
            );
        }

        return handleTokenUriErrorResponse(contract, tokenId, error, "error");
      });
  }
}

export const onchainMetadataProvider = new OnchainMetadataProvider();
