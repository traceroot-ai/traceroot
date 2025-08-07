export enum ResourceType {
  GITHUB = "github",
  NOTION = "notion",
  SLACK = "slack",
  OPENAI = "openai",
  GROQ = "groq",
  TRACEROOT = "traceroot"
}

export interface TokenResource {
  token?: string | null;
  resourceType: ResourceType;
}
