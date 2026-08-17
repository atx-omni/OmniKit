import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "get";
  model_id: string;
  topic_name?: string;
}

const UPSTREAM_TIMEOUT_MS = 15_000;

async function fetchUpstream(req: Request, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) controller.abort(req.signal.reason);
  else req.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", forwardAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidTopicInventoryResponse(): Response {
  return new Response(JSON.stringify({ error: "Topic inventory response was invalid." }), {
    status: 502,
    headers: jsonHeaders,
  });
}

function invalidTopicDetailResponse(): Response {
  return new Response(JSON.stringify({ error: "Topic detail response was invalid." }), {
    status: 502,
    headers: jsonHeaders,
  });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action, model_id } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !action || !model_id) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, action, and model_id are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    switch (action) {
      case "list": {
        const response = await fetchUpstream(
          req,
          `${cleanUrl}/api/v1/models/${encodeURIComponent(model_id)}/yaml`,
          { method: "GET", headers: authHeaders }
        );
        if (!response.ok) {
          return new Response(JSON.stringify({ error: "Topic inventory request failed." }), {
            status: response.status,
            headers: jsonHeaders,
          });
        }

        let yamlData: unknown;
        try {
          yamlData = await response.json();
        } catch {
          return invalidTopicInventoryResponse();
        }
        if (
          !isRecord(yamlData)
          || Object.prototype.hasOwnProperty.call(yamlData, "error")
          || Object.prototype.hasOwnProperty.call(yamlData, "errors")
          || !Object.prototype.hasOwnProperty.call(yamlData, "files")
          || !isRecord(yamlData.files)
        ) return invalidTopicInventoryResponse();

        const topics: Array<{ name: string; label?: string; description?: string }> = [];
        for (const [filePath, content] of Object.entries(yamlData.files)) {
          if (!filePath || typeof content !== "string") return invalidTopicInventoryResponse();
          const fileName = filePath.split("/").pop() ?? filePath;
          if (!fileName.endsWith(".topic")) continue;

          const topicName = fileName.replace(/\.topic$/, "");
          if (!topicName) return invalidTopicInventoryResponse();

          const labelMatch = content.match(/^label:\s*["']?(.+?)["']?\s*$/m);
          const label = labelMatch?.[1].trim();
          const descMatch = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
          const description = descMatch?.[1].trim();

          topics.push({ name: topicName, ...(label ? { label } : {}), ...(description ? { description } : {}) });
        }

        return new Response(JSON.stringify({ topics }), {
          status: 200,
          headers: jsonHeaders,
        });
      }

      case "get": {
        if (!body.topic_name) {
          return new Response(
            JSON.stringify({ error: "topic_name is required for get action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        const response = await fetchUpstream(
          req,
          `${cleanUrl}/api/v1/models/${encodeURIComponent(model_id)}/topic/${encodeURIComponent(body.topic_name)}`,
          { method: "GET", headers: authHeaders }
        );
        if (!response.ok) {
          return new Response(JSON.stringify({ error: "Topic detail request failed." }), {
            status: response.status,
            headers: jsonHeaders,
          });
        }

        let getData: unknown;
        try {
          getData = await response.json();
        } catch {
          return invalidTopicDetailResponse();
        }
        if (
          !isRecord(getData)
          || Object.prototype.hasOwnProperty.call(getData, "error")
          || Object.prototype.hasOwnProperty.call(getData, "errors")
          || getData.success !== true
          || !isRecord(getData.topic)
          || Object.prototype.hasOwnProperty.call(getData.topic, "error")
          || Object.prototype.hasOwnProperty.call(getData.topic, "errors")
          || getData.topic.name !== body.topic_name
        ) return invalidTopicDetailResponse();

        return new Response(JSON.stringify(getData.topic), {
          status: 200,
          headers: jsonHeaders,
        });
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: jsonHeaders }
        );
    }
  } catch {
    return new Response(JSON.stringify({ error: "Topic request failed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
