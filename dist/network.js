const CREDENTIAL_HEADERS = new Set([
    "authorization",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-api-key",
    "x-signature",
]);
const SAFE_HEADERS = new Set([
    "content-type",
    "content-length",
    "cache-control",
    "etag",
    "traceparent",
    "x-request-id",
    "cf-ray",
]);
const DEFAULT_EXCLUSIONS = [
    /(?:login|logout|oauth|password|token|refresh|session|payment|stripe)/i,
];
function safeHeaders(headers) {
    const output = {};
    headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        if (SAFE_HEADERS.has(lower) && !CREDENTIAL_HEADERS.has(lower))
            output[lower] = value.slice(0, 500);
    });
    return JSON.stringify(output);
}
function excluded(url, configuration) {
    return [...DEFAULT_EXCLUSIONS, ...(configuration.network?.excludedUrlPatterns ?? [])].some((pattern) => pattern.test(url));
}
async function readResponseBody(response, maximum) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("json") && !contentType.startsWith("text/"))
        return {};
    const text = await response.clone().text();
    return { body: text.slice(0, maximum), bytes: text.length, truncated: text.length > maximum };
}
function requestBody(input, init, maximum) {
    const candidate = init?.body;
    if (typeof candidate !== "string")
        return {};
    if (/multipart\/form-data/i.test(new Headers(init?.headers).get("content-type") ?? ""))
        return {};
    return { body: candidate.slice(0, maximum), bytes: candidate.length, truncated: candidate.length > maximum };
}
export function installNetworkCapture(configuration, emit) {
    const originalFetch = window.fetch;
    const requestMaximum = configuration.network?.requestBodyBytes ?? 256 * 1_024;
    const responseMaximum = configuration.network?.responseBodyBytes ?? 512 * 1_024;
    const patchedFetch = async (input, init) => {
        const started = performance.now();
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const url = input instanceof Request ? input.url : String(input);
        const captureBodies = configuration.network?.captureTextBodies !== false && !excluded(url, configuration);
        const request = captureBodies ? requestBody(input, init, requestMaximum) : {};
        try {
            const response = await originalFetch.call(window, input, init);
            const responseBody = captureBodies ? await readResponseBody(response, responseMaximum) : {};
            emit({
                type: "network",
                offsetMs: Date.now(),
                method,
                url,
                status: response.status,
                durationMs: Math.round(performance.now() - started),
                requestBody: request.body,
                requestBytes: request.bytes,
                requestTruncated: request.truncated,
                responseBody: responseBody.body,
                responseBytes: responseBody.bytes,
                responseTruncated: responseBody.truncated,
                headers: safeHeaders(response.headers),
            });
            return response;
        }
        catch (cause) {
            emit({
                type: "network",
                offsetMs: Date.now(),
                method,
                url,
                durationMs: Math.round(performance.now() - started),
                failure: cause instanceof Error ? cause.name : "NetworkError",
            });
            throw cause;
        }
    };
    window.fetch = patchedFetch;
    return () => {
        if (window.fetch === patchedFetch)
            window.fetch = originalFetch;
    };
}
//# sourceMappingURL=network.js.map