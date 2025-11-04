export enum ResourceType {
  GITHUB = "github",
  NOTION = "notion",
  SLACK = "slack",
  OPENAI = "openai",
  TRACEROOT = "traceroot",
}

export interface TokenResource {
  token?: string | null;
  resourceType: ResourceType;
}
