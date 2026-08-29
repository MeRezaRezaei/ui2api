export type ExecutionMode = "live-js" | "replay";

export interface ActionParam {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required: boolean;
  description?: string;
}

export interface NetworkInfo {
  method: string;
  url: string;
  requestBody?: unknown;
}

export interface Action {
  name: string;
  description: string;
  execution: ExecutionMode;
  parameters: ActionParam[];
  recipe: {
    kind: "js-function" | "dom-interaction";
    target: string;
    argsFrom: Record<string, string>;
    network?: NetworkInfo;
  };
  result: {
    mode: "return" | "dom";
    extract?: string;
    shape?: string;
  };
  verified: boolean;
}

export interface ActionMap {
  host: string;
  url: string;
  capturedAt: string;
  trusted?: boolean;
  auth: { required: boolean; method?: string };
  actions: Action[];
}

export interface MethodCall {
  target: string;
  method: string;
  params: string[];
  sampleArgs: unknown[];
  jsFunctionCapture: any;
  jsReturnCapture: any;
  networkCapture: any;
}

export interface DomInteraction {
  selector: string;
  label: string;
  domKind: "click" | "submit";
  fields: string[];
  network: NetworkInfo | null;
  verified: boolean;
}
