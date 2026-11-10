import {
  acceptIncident,
  advanceIncident,
  categoryNames,
  contractors,
  createIncident,
  emergencyGuidance,
  parseReport,
  resolveIncident,
} from "../domain.ts";
import type { Incident } from "../domain.ts";
import type { RoutingSettings } from "../routing.ts";
import { sampleIncidents } from "../seed.ts";

type Page = "incidents" | "workflow" | "settings";
type Filter = "open" | "escalated" | "resolved";
const app = document.querySelector<HTMLElement>("#app")!;
const dialogRoot = document.querySelector<HTMLElement>("#modal-root")!;
const toastRoot = document.querySelector<HTMLElement>("#toast")!;
const statusLabels = {
  queued: "Queued",
  offered: "Awaiting acceptance",
  accepted: "Accepted",
  escalated: "Needs attention",
  resolved: "Resolved",
};
const sourceLabels = {
  web: "Web",
  email: "Email",
  whatsapp: "WhatsApp",
  phone: "Phone",
};
const titles = {
  "fire-alarm": "Fire alarm panel fault",
  water: "Water or plumbing issue",
  access: "Door or access issue",
  electrical: "Electrical issue",
  other: "Maintenance report",
};
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const clock = new Intl.DateTimeFormat("en-IE", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Dublin",
});
const date = new Intl.DateTimeFormat("en-IE", {
  day: "numeric",
  month: "short",
  timeZone: "Europe/Dublin",
});

let page: Page = "incidents";
let filter: Filter = "open";
let search = "";
let demo = true;
let serverAvailable = false;
let signedIn = false;
let live = false;
let inbox: string | null = null;
let emailKeyConfigured = false;
let routing: RoutingSettings | null = null;
let demoClock = Date.now();
let incidents = readDemo();
let toastTimer: ReturnType<typeof setTimeout>;

function readDemo(): Incident[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem("blockops-demo-v1") || "null",
    );
    if (
      Array.isArray(value) &&
      value.every((i) => i?.id && Array.isArray(i.events))
    )
      return value;
  } catch {}
  return sampleIncidents();
}

function saveDemo() {
  try {
    localStorage.setItem("blockops-demo-v1", JSON.stringify(incidents));
  } catch {
    toast("Browser storage is unavailable.");
  }
}

function toast(message: string) {
  clearTimeout(toastTimer);
  toastRoot.textContent = message;
  toastRoot.classList.add("show");
  toastTimer = setTimeout(() => toastRoot.classList.remove("show"), 4000);
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload as T;
}

async function loadDesk() {
  const result = await request<{ incidents: Incident[] }>("/api/incidents");
  incidents = result.incidents;
  signedIn = true;
  demo = false;
}

function nav(label: string, target: Page) {
  return (
    '<button type="button" data-page="' +
    target +
    '"' +
    (page === target ? ' aria-current="page"' : "") +
    ">" +
    label +
    "</button>"
  );
}

function render() {
  const signedOut = !demo && !signedIn;
  const title =
    page === "workflow"
      ? "Workflow"
      : page === "settings" || signedOut
        ? "Settings"
        : "Incidents";
  app.innerHTML =
    '<a class="skip" href="#main">Skip to content</a>' +
    '<header class="top"><div class="top-inner"><a class="brand" href="/" aria-label="BlockOps home"><span class="brand-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i></span>BlockOps</a>' +
    '<nav aria-label="Main navigation">' +
    nav("Incidents", "incidents") +
    (demo ? nav("Workflow", "workflow") : "") +
    nav("Settings", "settings") +
    "</nav>" +
    '<span class="mode"><i></i>' +
    (demo ? "Demo" : live ? "Live" : "Pilot") +
    "</span></div></header>" +
    '<main id="main"><div class="heading"><div><p class="property">Shoreside Commons <span aria-hidden="true">·</span> Bray</p><h1>' +
    title +
    "</h1></div>" +
    '<button class="button primary" data-action="report"><span aria-hidden="true">+</span> Report issue</button></div>' +
    (signedOut || page === "settings"
      ? settingsPage()
      : page === "workflow"
        ? workflowPage()
        : incidentPage()) +
    (inbox
      ? '<p class="desk-foot">Report by email <a href="mailto:' +
        esc(inbox) +
        '">' +
        esc(inbox) +
        "</a></p>"
      : "") +
    "</main>";
  bindPage();
}

function incidentPage() {
  const openCount = incidents.filter((i) => i.status !== "resolved").length;
  const attentionCount = incidents.filter(
    (i) => i.status === "escalated",
  ).length;
  const filters: [Filter, string, number][] = [
    ["open", "Open", openCount],
    ["escalated", "Needs attention", attentionCount],
    ["resolved", "Resolved", incidents.length - openCount],
  ];
  return (
    '<section class="incident-card" aria-label="Incident list">' +
    '<div class="toolbar"><div class="filters" role="group" aria-label="Filter incidents">' +
    filters
      .map(
        ([key, label, count]) =>
          '<button data-filter="' +
          key +
          '" aria-pressed="' +
          (filter === key) +
          '">' +
          label +
          " <span>" +
          count +
          "</span></button>",
      )
      .join("") +
    '</div><label class="search"><span class="sr-only">Search incidents</span><input type="search" id="search" value="' +
    esc(search) +
    '" placeholder="Search incidents"></label></div>' +
    '<div class="column-labels" aria-hidden="true"><span>Issue</span><span>Status</span><span>Updated</span><span></span></div>' +
    '<div id="incident-rows">' +
    rows() +
    "</div></section>"
  );
}

function rows() {
  const query = search.trim().toLowerCase();
  const result = incidents
    .filter((i) => {
      const matchesStatus =
        filter === "open" ? i.status !== "resolved" : i.status === filter;
      return (
        matchesStatus &&
        (
          titles[i.category] +
          " " +
          i.reference +
          " " +
          i.location +
          " " +
          i.description
        )
          .toLowerCase()
          .includes(query)
      );
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (!result.length)
    return (
      '<div class="empty"><strong>' +
      (query
        ? "No matching incidents"
        : filter === "open"
          ? "No open incidents"
          : filter === "resolved"
            ? "No resolved incidents"
            : "Nothing needs attention") +
      "</strong>" +
      (query
        ? '<button class="text-button" data-action="clear-search">Clear search</button>'
        : "") +
      "</div>"
    );
  return result
    .map(
      (i) =>
        '<button class="incident-row" data-incident="' +
        esc(i.id) +
        '">' +
        '<span class="issue"><span class="issue-title">' +
        esc(titles[i.category]) +
        (i.priority === "critical" && i.status !== "resolved"
          ? '<span class="critical">Critical</span>'
          : "") +
        '</span><span class="issue-meta">' +
        esc(i.location) +
        ' <span aria-hidden="true">·</span> ' +
        esc(i.reference) +
        "</span></span>" +
        status(i) +
        '<time datetime="' +
        new Date(i.updatedAt).toISOString() +
        '">' +
        (date.format(i.updatedAt) === date.format(Date.now())
          ? clock.format(i.updatedAt)
          : date.format(i.updatedAt)) +
        '</time><span class="chevron" aria-hidden="true">›</span></button>',
    )
    .join("");
}

function status(incident: Incident) {
  return (
    '<span class="status ' +
    incident.status +
    '"><i></i>' +
    statusLabels[incident.status] +
    "</span>"
  );
}

function workflowPage() {
  return (
    '<section class="panel workflow"><h2>Contractor escalation</h2>' +
    "<ol><li><strong>Primary contractor</strong><span>5 minutes to accept</span></li><li><strong>Backup contractor</strong><span>5 minutes to accept</span></li><li><strong>Duty manager</strong><span>Follow up if neither accepts</span></li></ol>" +
    '<button class="button primary" data-action="advance">Advance 5 minutes</button></section>'
  );
}

function settingsPage() {
  const login =
    serverAvailable && !signedIn
      ? '<form id="login-form"><label>Desk password<input name="password" type="password" autocomplete="current-password" required></label><p class="error" role="alert"></p><button class="button primary">Sign in</button></form>'
      : "";
  const fields = routing
    ? contractors
        .map(
          (c) =>
            "<label>" +
            esc(c.trade.replace(" · backup", "")) +
            " · " +
            (c.id.endsWith("backup") ? "backup" : "primary") +
            '<input type="email" name="' +
            c.id +
            '" value="' +
            esc(routing!.contractorEmails[c.id]) +
            '"></label>',
        )
        .join("")
    : "";
  return (
    '<div class="settings"><section class="panel"><h2>Operator access</h2>' +
    (signedIn
      ? '<button class="button secondary" data-action="logout">Sign out</button>'
      : login || "<p>The demo uses sample data.</p>") +
    "</section>" +
    '<section class="panel"><h2>Resident reporting</h2>' +
    (inbox
      ? '<p><a href="mailto:' + esc(inbox) + '">' + esc(inbox) + "</a></p>"
      : signedIn && emailKeyConfigured ? '<p><button class="button primary" data-action="connect-email">Connect Resend</button></p>' : "") +
    '<button class="button secondary" data-action="copy-link">Copy report link</button></section>' +
    (signedIn && routing
      ? '<section class="panel wide"><h2>Email routing</h2><form id="routing-form"><div class="fields">' +
        '<label>Duty manager email<input name="managerEmail" type="email" value="' +
        esc(routing.managerEmail) +
        '"></label>' +
        '<label>Enrolled residents<textarea name="residentEmails" rows="3" placeholder="One email per line">' +
        esc(routing.residentEmails.join("\n")) +
        "</textarea></label></div>" +
        '<details><summary>Approved contractors</summary><div class="fields">' +
        fields +
        "</div></details>" +
        '<label class="choice"><input type="checkbox" name="automaticOffers" ' +
        (routing.automaticOffers ? "checked" : "") +
        "> Allow automatic offers for eligible reports</label>" +
        '<p class="error" role="alert"></p><button class="button primary">Save routing</button></form></section>'
      : "") +
    '<section class="panel wide utility">' +
    '<button class="button secondary" data-action="export">Export incidents</button>' +
    (demo
      ? '<button class="text-button" data-action="reset">Reset demo</button>'
      : "") +
    "</section></div>"
  );
}

function openDialog(title: string, content: string, drawer = false) {
  const previous = dialogRoot.querySelector("dialog");
  if (previous?.open) previous.close();
  dialogRoot.innerHTML =
    '<dialog class="' +
    (drawer ? "drawer" : "dialog") +
    '" aria-labelledby="dialog-title"><div class="dialog-head"><h2 id="dialog-title">' +
    esc(title) +
    '</h2><button type="button" class="close" aria-label="Close dialog">×</button></div><div class="dialog-body">' +
    content +
    "</div></dialog>";
  const dialog = dialogRoot.querySelector<HTMLDialogElement>("dialog")!;
  dialog.querySelector<HTMLButtonElement>(".close")!.onclick = () =>
    dialog.close();
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.showModal();
  return dialog;
}

function detail(incident: Incident) {
  const assigned =
    incident.status === "escalated"
      ? "Duty manager"
      : demo
        ? contractors.find((c) => c.id === incident.contractorId)?.name
        : incident.contractorId?.replace(/-/g, " ");
  const actions = [];
  if (demo && incident.status === "offered")
    actions.push(
      '<button class="button secondary" data-detail="accept">Simulate acceptance</button>',
    );
  if (
    signedIn &&
    incident.reviewRequired &&
    incident.status === "escalated" &&
    incident.category !== "other"
  ) {
    actions.push(
      '<button class="button primary" data-detail="dispatch">Approve contractor offer</button>',
    );
  }
  if (incident.status !== "resolved")
    actions.push(
      '<button class="button secondary" data-detail="resolve">Record resolution</button>',
    );
  const dialog = openDialog(
    titles[incident.category],
    '<div class="incident-summary"><p class="reference">' +
      esc(incident.reference) +
      " <span>·</span> " +
      sourceLabels[incident.source] +
      "</p>" +
      '<div class="badges">' +
      status(incident) +
      (incident.priority === "critical"
        ? '<span class="critical">Critical</span>'
        : "") +
      "</div>" +
      "<h3>" +
      esc(incident.location) +
      '</h3><p class="description">' +
      esc(incident.description) +
      "</p>" +
      (assigned
        ? '<p class="assignee">Assigned to <strong>' +
          esc(assigned) +
          "</strong></p>"
        : "") +
      "</div>" +
      (incident.priority === "critical"
        ? '<p class="safety">' + esc(emergencyGuidance) + "</p>"
        : "") +
      '<h3 class="timeline-heading">Activity</h3><ol class="timeline">' +
      [...incident.events]
        .reverse()
        .map(
          (event) =>
            "<li><strong>" +
            esc(event.title) +
            "</strong><time>" +
            clock.format(event.at) +
            "</time><p>" +
            esc(event.detail) +
            "</p></li>",
        )
        .join("") +
      '</ol><p class="error" role="alert"></p>' +
      (actions.length
        ? '<div class="dialog-actions">' + actions.join("") + "</div>"
        : ""),
    true,
  );
  dialog
    .querySelectorAll<HTMLButtonElement>("[data-detail]")
    .forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.detail;
        if (action === "resolve") return resolution(incident);
        button.disabled = true;
        try {
          if (action === "accept") {
            const accepted = acceptIncident(
              incident,
              incident.contractorId!,
              Math.min(demoClock, incident.dueAt! - 1),
            );
            incidents = incidents.map((i) =>
              i.id === accepted.id ? accepted : i,
            );
            saveDemo();
          } else {
            await request("/api/incidents/" + incident.id + "/dispatch", {});
            await loadDesk();
          }
          render();
          detail(incidents.find((i) => i.id === incident.id)!);
        } catch (error) {
          showError(dialog, error);
        } finally {
          button.disabled = false;
        }
      };
    });
}

function showError(container: HTMLElement, error: unknown) {
  const target = container.querySelector(".error");
  if (target)
    target.textContent =
      error instanceof Error ? error.message : "Request failed.";
}

function resolution(incident: Incident) {
  const dialog = openDialog(
    "Record resolution",
    '<form><label>What was fixed?<textarea name="note" rows="4" required minlength="10" maxlength="2000"></textarea></label>' +
      '<p class="error" role="alert"></p><button class="button primary">Save resolution</button></form>',
  );
  const form = dialog.querySelector("form")!;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const note = String(new FormData(form).get("note"));
    try {
      if (demo) {
        const updated = resolveIncident(incident, note);
        incidents = incidents.map((i) => (i.id === updated.id ? updated : i));
        saveDemo();
      } else {
        await request("/api/incidents/" + incident.id + "/resolve", { note });
        await loadDesk();
      }
      dialog.close();
      render();
      toast("Resolution saved.");
    } catch (error) {
      showError(form, error);
    }
  };
}

function report() {
  const dialog = openDialog(
    "Report an issue",
    '<p class="safety"><strong>Fire, smoke or immediate danger?</strong> <a href="tel:112">Call 112 or 999</a>. Follow the building emergency plan.</p>' +
      (demo
        ? '<p class="demo-note">This report stays in your browser.</p>'
        : "") +
    '<form id="report-form"><label>Issue type<select name="category" required><option value="" selected disabled>Select an issue</option>' +
      Object.entries(categoryNames)
        .map(
          ([key, label]) =>
            '<option value="' + key + '">' + label + "</option>",
        )
        .join("") +
      '</select></label><label>Location<input name="location" required minlength="2" maxlength="160" placeholder="Block B, ground-floor lobby"></label>' +
      '<label>What happened?<textarea name="description" rows="3" required minlength="10" maxlength="3000"></textarea></label>' +
      '<label class="choice"><input type="checkbox" name="danger"> There may be immediate danger</label>' +
      (demo
        ? ""
        : '<label>Resident access code<input name="accessCode" type="password" required autocomplete="off"></label>') +
      '<p class="error" role="alert"></p><button class="button primary">' +
      (demo ? "Create demo report" : "Submit report") +
      "</button></form>",
  );
  const form = dialog.querySelector("form")!;
  const idempotencyKey = crypto.randomUUID();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = form.querySelector("button")!;
    button.disabled = true;
    const data = new FormData(form);
    try {
      const report = parseReport({
        category: data.get("category"),
        location: data.get("location"),
        description: data.get("description"),
        danger: data.has("danger"),
      });
      if (demo) {
        const now = Math.max(demoClock, Date.now());
        const incident = advanceIncident(
          createIncident(report, crypto.randomUUID(), "demo-only", now),
          now,
        );
        incidents.unshift(incident);
        saveDemo();
        dialog.close();
        page = "incidents";
        filter = "open";
        search = "";
        render();
        detail(incident);
        toast("Demo report created.");
      } else {
        const response = await fetch("/api/reports", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            ...report,
            accessCode: data.get("accessCode"),
          }),
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || "Unable to record the report.");
        dialog.close();
        if (signedIn) {
          await loadDesk();
          render();
        }
        openDialog(
          "Report recorded",
          "<p>Your reference is <strong>" +
            esc(result.reference) +
            "</strong>.</p>" +
            (result.workflowPending
              ? "<p>Automatic routing is pending. Contact the duty manager for urgent follow-up.</p>"
              : ""),
        );
      }
    } catch (error) {
      showError(form, error);
    } finally {
      button.disabled = false;
    }
  };
}

function bindRows() {
  app
    .querySelectorAll<HTMLButtonElement>("[data-incident]")
    .forEach((button) => {
      button.onclick = () => {
        const incident = incidents.find(
          (i) => i.id === button.dataset.incident,
        );
        if (incident) detail(incident);
      };
    });
  const clear = app.querySelector<HTMLButtonElement>(
    '[data-action="clear-search"]',
  );
  if (clear)
    clear.onclick = () => {
      search = "";
      render();
      app.querySelector<HTMLInputElement>("#search")?.focus();
    };
}

function bindPage() {
  app.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => {
    button.onclick = () => {
      page = button.dataset.page as Page;
      render();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.onclick = () => {
      filter = button.dataset.filter as Filter;
      render();
    };
  });
  app.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    button.onclick = () => {
      void act(button.dataset.action!, button);
    };
  });
  const input = app.querySelector<HTMLInputElement>("#search");
  if (input)
    input.oninput = () => {
      search = input.value;
      app.querySelector("#incident-rows")!.innerHTML = rows();
      bindRows();
    };
  bindRows();
  const login = app.querySelector<HTMLFormElement>("#login-form");
  if (login)
    login.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await request("/api/login", {
          password: new FormData(login).get("password"),
        });
        await loadDesk();
        routing = await request("/api/settings");
        page = "incidents";
        render();
      } catch (error) {
        showError(login, error);
      }
    };
  const form = app.querySelector<HTMLFormElement>("#routing-form");
  if (form)
    form.onsubmit = async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        routing = await request("/api/settings", {
          managerEmail: data.get("managerEmail"),
          residentEmails: String(data.get("residentEmails"))
            .split(/[\r\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          contractorEmails: Object.fromEntries(
            contractors.map((c) => [c.id, data.get(c.id)]),
          ),
          automaticOffers: data.has("automaticOffers"),
        });
        toast("Routing saved.");
      } catch (error) {
        showError(form, error);
      }
    };
}

async function act(action: string, button: HTMLButtonElement) {
  if (action === "report") return report();
  if (action === "connect-email") {
    button.disabled = true;
    try {
      const result = await request<{ email: string }>("/api/settings/email", {});
      inbox = result.email;
      render();
      toast("Email connected.");
    } catch (error) { toast((error as Error).message); }
    finally { button.disabled = false; }
    return;
  }
  if (action === "advance") {
    demoClock = Math.max(demoClock, Date.now()) + 5 * 60_000;
    incidents = incidents.map((i) => advanceIncident(i, demoClock));
    saveDemo();
    toast("Demo clock advanced by 5 minutes.");
    return;
  }
  if (action === "reset") {
    const dialog = openDialog(
      "Reset sample incidents?",
      '<button class="button primary" id="reset-demo">Reset demo</button>',
    );
    dialog.querySelector<HTMLButtonElement>("#reset-demo")!.onclick = () => {
      demoClock = Date.now();
      incidents = sampleIncidents(demoClock);
      saveDemo();
      dialog.close();
      page = "incidents";
      filter = "open";
      render();
      toast("Demo reset.");
    };
    return;
  }
  if (action === "logout") {
    try {
      await request("/api/logout", {});
      signedIn = false;
      incidents = [];
      routing = null;
      page = "settings";
      render();
    } catch (error) {
      toast((error as Error).message);
    }
    return;
  }
  if (action === "copy-link") {
    const url = new URL("/?report", location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Report link copied.");
    } catch {
      openDialog(
        "Resident report link",
        '<input readonly value="' + esc(url) + '">',
      );
    }
    return;
  }
  if (action === "export") {
    const fields = [
      ["Reference", "Issue", "Location", "Status", "Updated"],
      ...incidents.map((i) => [
        i.reference,
        titles[i.category],
        i.location,
        statusLabels[i.status],
        new Date(i.updatedAt).toISOString(),
      ]),
    ];
    const csv = fields
      .map((row) =>
        row
          .map(
            (v) =>
              '"' +
              (/^[=+\-@\t\r]/.test(v) ? "'" : "") +
              v.replaceAll('"', '""') +
              '"',
          )
          .join(","),
      )
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "blockops-incidents.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function init() {
  const accept = new URLSearchParams(location.hash.slice(1) || location.search);
  const reportLink = new URLSearchParams(location.search).has("report");
  if (accept.has("accept")) {
    history.replaceState({}, "", location.pathname);
    render();
    const dialog = openDialog(
      "Accept this call-out?",
      '<p>Confirm that you can attend. Contact the duty manager with your ETA.</p><p class="error" role="alert"></p><button class="button primary" id="accept-live">Accept call-out</button>',
    );
    const button = dialog.querySelector<HTMLButtonElement>("#accept-live")!;
    button.onclick = async () => {
      button.disabled = true;
      try {
        await request("/api/accept", {
          id: accept.get("accept"),
          contractorId: accept.get("contractor"),
          token: accept.get("token"),
        });
        openDialog(
          "Call-out accepted",
          "<p>Share your ETA with the duty manager.</p>",
        );
      } catch (error) {
        showError(dialog, error);
      } finally {
        button.disabled = false;
      }
    };
    return;
  }
  try {
    const config = await request<{
      demo: boolean;
      backend: boolean;
      live: boolean;
      email: string | null;
      emailKeyConfigured?: boolean;
    }>("/api/config");
    serverAvailable = config.backend;
    demo = config.demo;
    live = config.live;
    inbox = config.email;
    emailKeyConfigured = Boolean(config.emailKeyConfigured);
    if (serverAvailable) {
      try {
        await loadDesk();
        routing = await request("/api/settings");
      } catch {
        if (!demo) {
          incidents = [];
          page = "settings";
        }
      }
    }
  } catch {}
  render();
  if (reportLink) report();
}

void init();
setInterval(() => {
  if (
    !signedIn ||
    page !== "incidents" ||
    dialogRoot.querySelector("dialog[open]") ||
    document.activeElement?.id === "search"
  )
    return;
  void loadDesk()
    .then(render)
    .catch(() => {});
}, 15_000);
