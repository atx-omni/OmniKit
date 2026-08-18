import { validateBaseUrl, jsonHeaders } from '../security';

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "get" | "create" | "update" | "patch";
  count?: number;
  start_index?: number;
  group_id?: string;
  group_data?: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action } = body;

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !action) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, and action are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const scimBase = `${cleanUrl}/api/scim/v2/groups`;
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    let response: Response;

    switch (action) {
      case "list": {
        const count = body.count || 100;
        const startIndex = body.start_index || 1;
        response = await fetch(
          `${scimBase}?count=${count}&startIndex=${startIndex}`,
          { method: "GET", headers: authHeaders, redirect: "manual", signal: req.signal }
        );
        break;
      }

      case "get": {
        if (!body.group_id) {
          return new Response(
            JSON.stringify({ error: "group_id is required for get action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${encodeURIComponent(body.group_id)}`, {
          method: "GET",
          headers: authHeaders,
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "create": {
        if (!body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_data is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(scimBase, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "update": {
        if (!body.group_id || !body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_id and group_data are required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${encodeURIComponent(body.group_id)}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "patch": {
        if (!body.group_id || !body.group_data) {
          return new Response(
            JSON.stringify({ error: "group_id and group_data are required for patch action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${encodeURIComponent(body.group_id)}`, {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify(body.group_data),
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action." }),
          { status: 400, headers: jsonHeaders }
        );
    }

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `Omni group request failed with HTTP ${response.status}.` }),
        { status: response.status, headers: jsonHeaders }
      );
    }
    if (response.status === 204) {
      return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
    }
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch {
    return new Response(JSON.stringify({ error: "The Omni group request could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
