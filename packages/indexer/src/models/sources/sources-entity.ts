export type SourcesEntityParams = {
  id: number;
  domain: string;
  domainHash: string;
  name: string;
  address: string;
  metadata: SourcesMetadata;
  optimized: boolean;
  createdAt: string;
};

export type SourcesMetadata = {
  adminTitle?: string;
  adminIcon?: string;
  title?: string;
  icon?: string;
  url?: string;
  allowedApiKeys?: string[];
  description?: string;
  twitterUsername?: string;
  socialImage?: string;
  tokenUrl?: string;
};

export class SourcesEntity {
  id: number;
  name: string;
  domain: string;
  domainHash: string;
  address: string;
  metadata: SourcesMetadata;
  optimized: boolean;
  createdAt: string;

  constructor(params: SourcesEntityParams) {
    this.id = params.id;
    this.name = params.name;
    this.domain = params.domain;
    this.domainHash = params.domainHash;
    this.address = params.address;
    this.metadata = params.metadata;
    this.optimized = params.optimized;
    this.createdAt = params.createdAt;
  }

  getIcon() {
    return this.metadata.adminIcon || this.metadata.icon;
  }

  getTitle() {
    return this.metadata.adminTitle || this.metadata.title || this.name;
  }
}
