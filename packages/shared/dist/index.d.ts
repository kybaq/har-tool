export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type RequestLog = {
    id: string;
    ts: number;
    method: HttpMethod;
    url: string;
    host: string;
    path: string;
    status?: number;
    durationMs?: number;
    request: {
        headers: Record<string, string>;
        query?: Record<string, string>;
        body?: {
            mime?: string;
            text?: string;
        };
    };
    response?: {
        headers?: Record<string, string>;
        body?: {
            mime?: string;
            text?: string;
        };
    };
};
