export interface AdParamCheck {
  originalParams: Record<string, string>;
  finalParams: Record<string, string>;
  preserved: boolean;
  missingParams: string[];
}

export interface BrokenImage {
  src: string;
  alt?: string;
  statusCode?: number;
}

export interface ConsoleError {
  message: string;
  type: string;
  timestamp: number;
}

export interface AdditionalChecks {
  is404: boolean;
  pageLoadTimeMs: number;
  adParamCheck: AdParamCheck | null;
  brokenImages: BrokenImage[];
  consoleErrors: ConsoleError[];
}
