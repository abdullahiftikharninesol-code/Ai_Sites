import { useEffect, useMemo, useRef, useState } from "react";
import {
  PlaygroundApiClient,
  formatProviderName,
  type IntelligenceTaskStatus,
  type JobStatus,
  type LocalInstanceStatus,
  type ProgressEvent,
  type SiteDetail,
  type SiteSummary,
} from "./api-client";
import "./styles.css";

const northSmilePrompt = `Create a modern responsive website for a dental clinic called NorthSmile Dental.

Pages:
- Home
- Services
- Dentists
- Contact

Home should include:
- hero section
- clinic benefits
- featured services
- dentist introduction
- patient testimonials
- appointment CTA

Services should present:
- General Dentistry
- Teeth Whitening
- Dental Implants
- Orthodontics

Dentists should show three dentist profile cards with specialty and short biography.

Contact should include:
- clinic contact information
- opening hours
- appointment/contact form

Design:
- modern and professional
- clean medical aesthetic
- strong typography
- responsive desktop/mobile layout
- polished cards and sections
- clear navigation and CTAs

Use the existing Sites React + TypeScript + CSS architecture.`;

const defaultPrompt =
  "Build a modern digital consulting company website with Home, Services, About, Testimonials and Contact. Include a working contact form.";
const defaultEditPrompt =
  "Make the hero more compact and add a three-column benefits section below it.";
const presets = [
  {
    id: "northsmile",
    label: "NorthSmile Dental",
    description: "Multi-page clinic site with forms and profile cards",
    prompt: northSmilePrompt,
  },
  {
    id: "consulting",
    label: "Consulting studio",
    description: "Fast baseline for a polished marketing site",
    prompt: defaultPrompt,
  },
  {
    id: "restaurant",
    label: "Local restaurant",
    description: "Menu, story, location and reservation CTA",
    prompt:
      "Create a responsive website for a neighborhood restaurant called Ember & Grain. Include Home, Menu, Our Story and Contact pages, a featured dishes section, chef profile, opening hours, location, reservation form and strong mobile layout. Use the existing React + TypeScript + CSS architecture.",
  },
];

const planningTasks: Record<string, IntelligenceTaskStatus["taskKind"]> = {
  requirements: "REQUIREMENTS_PLANNING",
  design: "DESIGN_PLANNING",
  runtime: "RUNTIME_PLANNING",
  auth: "AUTH_PLANNING",
  integrations: "INTEGRATION_PLANNING",
  content: "CONTENT_GENERATION",
};
const taskOrder: IntelligenceTaskStatus["taskKind"][] = [
  "INTENT_CLASSIFICATION",
  "REQUIREMENTS_PLANNING",
  "DESIGN_PLANNING",
  "RUNTIME_PLANNING",
  "AUTH_PLANNING",
  "INTEGRATION_PLANNING",
  "CONTENT_GENERATION",
  "CODE_GENERATION",
  "TOOL_LOOP",
  "BUILD_REPAIR",
  "TARGETED_EDIT",
  "VISUAL_REVIEW",
  "VISUAL_REPAIR",
];
const taskNames: Record<IntelligenceTaskStatus["taskKind"], string> = {
  INTENT_CLASSIFICATION: "Intent",
  REQUIREMENTS_PLANNING: "Requirements",
  DESIGN_PLANNING: "Design",
  CAPABILITY_PLANNING: "Capabilities",
  RUNTIME_PLANNING: "Runtime planning",
  AUTH_PLANNING: "Auth planning",
  INTEGRATION_PLANNING: "Integration planning",
  CONTENT_GENERATION: "Content",
  CODE_GENERATION: "Code generation",
  TOOL_LOOP: "Tool loop",
  BUILD_REPAIR: "Build repair",
  TARGETED_EDIT: "Targeted editing",
  VISUAL_REVIEW: "Visual review",
  VISUAL_REPAIR: "Visual repair",
};

type ConnectionState = "loading" | "online" | "offline";
const readableError = (reason: unknown, fallback: string) =>
  reason instanceof Error ? reason.message : fallback;
const formatTime = (value?: string) =>
  value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--";

export function App() {
  const api = useMemo(() => new PlaygroundApiClient(), []);
  const jobController = useRef<AbortController | undefined>(undefined);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [detail, setDetail] = useState<SiteDetail>();
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [editPrompt, setEditPrompt] = useState(defaultEditPrompt);
  const [selectedPreset, setSelectedPreset] = useState("consulting");
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [intelligence, setIntelligence] = useState<IntelligenceTaskStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [runStatus, setRunStatus] = useState<JobStatus["status"]>();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [instance, setInstance] = useState<LocalInstanceStatus>();
  const [width, setWidth] = useState("100%");
  const [frameKey, setFrameKey] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [mobileProjectsOpen, setMobileProjectsOpen] = useState(false);
  const [provider, setProvider] = useState("Loading");
  const [model, setModel] = useState("Loading");
  const [executionProvider, setExecutionProvider] = useState("Loading");

  useEffect(() => () => jobController.current?.abort(), []);
  const reloadSites = async () => {
    setSites(await api.sites());
    setLastUpdated(new Date().toISOString());
  };
  const refreshSites = async () => {
    setError("");
    try {
      await reloadSites();
      setConnection("online");
    } catch (reason) {
      setConnection("offline");
      setError(readableError(reason, "Unable to refresh projects"));
    }
  };
  const openSite = async (id: string) => {
    try {
      const value = await api.site(id);
      setDetail(value);
      setSelectedVersion(value.project.latestVersionId ?? value.versions.at(-1)?.versionId);
      if (value.activePreview)
        setPreview({
          id: value.activePreview.previewSessionId,
          url: value.activePreview.previewUrl,
        });
      setMobileProjectsOpen(false);
    } catch (reason) {
      setError(readableError(reason, "Unable to open project"));
    }
  };
  const deleteSite = async (site: SiteSummary) => {
    if (!confirm(`Delete ${site.name} and all of its local versions? This cannot be undone.`))
      return;
    setBusy(true);
    setError("");
    try {
      await api.deleteSite(site.projectId);
      if (detail?.project.projectId === site.projectId) {
        setDetail(undefined);
        setSelectedVersion(undefined);
        setPreview(undefined);
      }
      await reloadSites();
    } catch (reason) {
      setError(readableError(reason, "Unable to delete project"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refreshSites();
    void api
      .health()
      .then((health) => {
        setProvider(formatProviderName(health.agentProvider));
        setModel(health.agentModel);
        setExecutionProvider(formatProviderName(health.executionProvider));
        setConnection("online");
      })
      .catch((reason: unknown) => {
        setProvider("Unavailable");
        setModel("Unavailable");
        setExecutionProvider("Unavailable");
        setConnection("offline");
        setError(readableError(reason, "Unable to read backend health"));
      });
  }, []);
  useEffect(() => {
    if (!preview) {
      setInstance(undefined);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () =>
      void api
        .previewInstance(preview.id)
        .then((value) => active && setInstance(value))
        .catch(() => active && setInstance(undefined))
        .finally(() => {
          if (active) timer = setTimeout(refresh, 2_000);
        });
    refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, preview?.id]);

  const followJob = (jobId: string) =>
    new Promise<JobStatus>((resolve, reject) => {
      jobController.current?.abort();
      const controller = new AbortController();
      jobController.current = controller;
      setEvents([]);
      setIntelligence([]);
      setRunStatus("QUEUED");
      const updateIntelligence = (task: IntelligenceTaskStatus) =>
        setIntelligence((current) => [
          ...current.filter((item) => item.taskKind !== task.taskKind),
          task,
        ]);
      const stop = api.events(
        jobId,
        (event) => setEvents((current) => [...current, event].slice(-500)),
        updateIntelligence,
      );
      let timer: ReturnType<typeof setTimeout>;
      let done = false;
      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        stop();
        controller.signal.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Error("Stopped following job"));
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      const poll = () =>
        void api
          .job(jobId, controller.signal)
          .then((job) => {
            if (done) return;
            setRunStatus(job.status);
            setIntelligence(job.intelligence ?? []);
            if (job.status === "SUCCEEDED" || job.status === "FAILED") {
              cleanup();
              if (job.status === "FAILED") {
                const details = [
                  job.error?.status ? `HTTP ${job.error.status}` : "",
                  job.error?.providerCode ? `code ${job.error.providerCode}` : "",
                  job.error?.retryable ? "retryable" : "",
                ].filter(Boolean);
                reject(
                  new Error(
                    `${job.error?.message ?? "Job failed"}${details.length ? ` (${details.join(", ")})` : ""}`,
                  ),
                );
              } else resolve(job);
            }
          })
          .catch((reason: unknown) => {
            cleanup();
            reject(reason instanceof Error ? reason : new Error("Unable to read job status"));
          })
          .finally(() => {
            if (!done) timer = setTimeout(poll, 500);
          });
      poll();
    });

  const startVersionInstance = async (siteId: string, versionId: string) => {
    if (preview) await api.stopPreview(preview.id);
    const value = await api.preview(siteId, versionId);
    setPreview({ id: value.previewSessionId, url: value.previewUrl });
  };
  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const { jobId } = await api.generate(prompt);
      const job = await followJob(jobId);
      await reloadSites();
      if (job.projectId) await openSite(job.projectId);
      if (job.projectId && job.versionId) await startVersionInstance(job.projectId, job.versionId);
    } catch (reason) {
      setError(readableError(reason, "Generation failed"));
    } finally {
      setBusy(false);
    }
  };
  const edit = async () => {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const { jobId } = await api.edit(detail.project.projectId, editPrompt, selectedVersion);
      const job = await followJob(jobId);
      await openSite(detail.project.projectId);
      if (job.versionId) setSelectedVersion(job.versionId);
      if (job.versionId) await startVersionInstance(detail.project.projectId, job.versionId);
    } catch (reason) {
      setError(readableError(reason, "Edit failed"));
    } finally {
      setBusy(false);
    }
  };
  const startPreview = async () => {
    if (!detail || !selectedVersion) return;
    setBusy(true);
    setError("");
    try {
      if (preview) await api.stopPreview(preview.id);
      const value = await api.preview(detail.project.projectId, selectedVersion);
      setPreview({ id: value.previewSessionId, url: value.previewUrl });
    } catch (reason) {
      setError(readableError(reason, "Unable to start preview"));
    } finally {
      setBusy(false);
    }
  };
  const stopPreview = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await api.stopPreview(preview.id);
      setPreview(undefined);
      setInstance(undefined);
    } catch (reason) {
      setError(readableError(reason, "Unable to stop preview"));
    } finally {
      setBusy(false);
    }
  };
  const action = async (kind: "publish" | "rollback" | "unpublish") => {
    if (!detail || !selectedVersion) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "publish") await api.publish(detail.project.projectId, selectedVersion);
      else if (kind === "rollback") {
        const deployment = detail.deployments.find((item) => item.versionId === selectedVersion);
        if (!deployment || !confirm("Rollback to selected deployment?")) return;
        await api.rollback(detail.project.projectId, deployment.deploymentId);
      } else if (confirm("Unpublish this site?")) await api.unpublish(detail.project.projectId);
      await openSite(detail.project.projectId);
    } catch (reason) {
      setError(readableError(reason, "Project action failed"));
    } finally {
      setBusy(false);
    }
  };

  const isRateLimited = /429|rate.?limit/i.test(error);
  const isMockProvider = provider.toLowerCase() === "mock";
  const sortedIntelligence = [...intelligence].sort(
    (left, right) => taskOrder.indexOf(left.taskKind) - taskOrder.indexOf(right.taskKind),
  );
  const passedTasks = intelligence.filter((task) => task.success || task.status === "PASS").length;
  const currentVersion = detail?.versions.find((version) => version.versionId === selectedVersion);
  const selectPreset = (preset: (typeof presets)[number]) => {
    setSelectedPreset(preset.id);
    setPrompt(preset.prompt);
  };
  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key === "Enter" &&
      !busy &&
      prompt.trim().length >= 3
    ) {
      event.preventDefault();
      void generate();
    }
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <button
            className="mobile-menu"
            aria-label="Toggle projects"
            aria-expanded={mobileProjectsOpen}
            onClick={() => setMobileProjectsOpen((open) => !open)}
          >
            <span />
            <span />
            <span />
          </button>
          <span className="brand-mark">S</span>
          <div>
            <div className="brand-name">
              Sites <span>/</span> Lab
            </div>
            <p>Local AI website testing console</p>
          </div>
        </div>
        <div className="topbar-center">
          <span className="live-dot" /> Local workspace <span className="slash">/</span> v0.1
        </div>
        <div className="topbar-actions">
          <div className={`connection-pill ${connection}`}>
            <span className="connection-dot" />
            {connection === "loading"
              ? "Connecting"
              : connection === "online"
                ? "API online"
                : "API offline"}
          </div>
          <button
            className="icon-button"
            title="Refresh projects"
            aria-label="Refresh projects"
            onClick={() => void refreshSites()}
          >
            ↻
          </button>
        </div>
      </header>

      <aside className={`sidebar ${mobileProjectsOpen ? "mobile-open" : ""}`}>
        <div className="sidebar-heading">
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h2>Projects</h2>
          </div>
          <span className="count-badge">{sites.length}</span>
        </div>
        <button
          className="new-project"
          onClick={() => {
            setDetail(undefined);
            setMobileProjectsOpen(false);
          }}
        >
          <span>+</span> New test run
        </button>
        <div className="project-list">
          {sites.length ? (
            sites.map((site) => (
              <div
                className={`project ${detail?.project.projectId === site.projectId ? "active" : ""}`}
                key={site.projectId}
              >
                <button className="project-select" onClick={() => void openSite(site.projectId)}>
                  <span className="project-icon">{site.name.slice(0, 1).toUpperCase()}</span>
                  <span className="project-copy">
                    <strong>{site.name}</strong>
                    <small>
                      {site.latestVersion ? `Version ${site.latestVersion}` : "Generating"}
                    </small>
                  </span>
                  <span className="project-arrow">›</span>
                </button>
                <button
                  className="project-delete"
                  title={`Delete ${site.name}`}
                  aria-label={`Delete ${site.name}`}
                  disabled={busy}
                  onClick={() => void deleteSite(site)}
                >
                  ×
                </button>
              </div>
            ))
          ) : (
            <div className="sidebar-empty">
              <span className="empty-folder">○</span>
              <strong>No projects yet</strong>
              <span>Your generated sites will appear here.</span>
            </div>
          )}
        </div>
        <div className="sidebar-footer">
          <div className="footer-status">
            <span className={`status-light ${connection}`} />{" "}
            <span>
              {connection === "online"
                ? "Ready for testing"
                : connection === "loading"
                  ? "Checking API"
                  : "Backend unavailable"}
            </span>
          </div>
          {lastUpdated && <small>Synced {formatTime(lastUpdated)}</small>}
        </div>
      </aside>

      <main className="workspace">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">{detail ? "PROJECT OVERVIEW" : "TEST WORKBENCH"}</span>
            <h1>{detail ? detail.project.name : "Build and test a site"}</h1>
            <p>
              {detail
                ? `${detail.project.slug} · choose a version, preview it, then iterate.`
                : "Turn a plain-language brief into a local, inspectable website."}
            </p>
          </div>
          {detail && (
            <button className="secondary" onClick={() => setDetail(undefined)}>
              ← New run
            </button>
          )}
        </div>
        <section className="system-banner">
          <div className="banner-icon">✦</div>
          <div>
            <strong>{isMockProvider ? "Safe test mode" : `Live ${provider} test mode`}</strong>
            <span>
              {isMockProvider
                ? "Mock intelligence + local execution. No provider quota is used."
                : `${provider} is active. Requests use your configured provider credential; builds stay local.`}
            </span>
          </div>
          <span className="banner-meta">{model}</span>
        </section>

        {!detail ? (
          <section className="builder-card">
            <div className="builder-intro">
              <div>
                <span className="step-label">
                  <span>01</span> DEFINE YOUR TEST
                </span>
                <h2>What should we build?</h2>
                <p>
                  Choose a scenario or describe your own site. The prompt is sent to the configured
                  agent and the result is built inside the local workspace.
                </p>
              </div>
              <div className="builder-decoration">
                <span />
                <span />
                <span />
              </div>
            </div>
            <div className="preset-label">
              <span>QUICK SCENARIOS</span>
              <small>Good starting points for repeatable testing</small>
            </div>
            <div className="preset-grid">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  className={`preset ${selectedPreset === preset.id ? "selected" : ""}`}
                  onClick={() => selectPreset(preset)}
                >
                  <span className="preset-check">{selectedPreset === preset.id ? "✓" : ""}</span>
                  <strong>{preset.label}</strong>
                  <small>{preset.description}</small>
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="site-prompt">
              SITE BRIEF <span>{prompt.length.toLocaleString()} / 20,000</span>
            </label>
            <textarea
              id="site-prompt"
              aria-label="Site prompt"
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                setSelectedPreset("");
              }}
              onKeyDown={handlePromptKeyDown}
              rows={8}
              placeholder="Describe the pages, sections, style and interactions you want to test..."
            />
            <div className="builder-footer">
              <span className="keyboard-hint">
                <kbd>Ctrl</kbd>
                <span>+</span>
                <kbd>Enter</kbd> to run
              </span>
              <button
                className="primary-action"
                disabled={busy || prompt.trim().length < 3 || connection === "offline"}
                onClick={() => void generate()}
              >
                <span>{busy ? "Running pipeline" : "Generate website"}</span>
                <span className="button-arrow">→</span>
              </button>
            </div>
          </section>
        ) : (
          <section className="project-card">
            <div className="project-summary">
              <div className="site-avatar">{detail.project.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <span className="eyebrow">ACTIVE PROJECT</span>
                <h2>{detail.project.name}</h2>
                <p>{detail.project.slug}</p>
              </div>
              <div className="summary-actions">
                <span className="version-state">
                  <span className="status-light online" />{" "}
                  {detail.project.publishedVersionId ? "Published" : "Draft"}
                </span>
              </div>
            </div>
            <div className="metric-row">
              <div>
                <span>VERSIONS</span>
                <strong>{detail.versions.length}</strong>
              </div>
              <div>
                <span>SELECTED BUILD</span>
                <strong>{currentVersion ? `V${currentVersion.versionNumber}` : "—"}</strong>
              </div>
              <div>
                <span>BUILD STATUS</span>
                <strong className="value-good">{currentVersion?.buildStatus ?? "Ready"}</strong>
              </div>
              <div>
                <span>EXECUTION</span>
                <strong>{executionProvider}</strong>
              </div>
            </div>
            <div className="section-line">
              <h3>Version history</h3>
              <span>Select a build to preview or publish it</span>
            </div>
            <div className="versions">
              {detail.versions.map((version) => (
                <button
                  key={version.versionId}
                  className={selectedVersion === version.versionId ? "selected" : ""}
                  onClick={() => setSelectedVersion(version.versionId)}
                >
                  <span className="version-number">V{version.versionNumber}</span>
                  <span className="version-info">
                    <strong>{version.published ? "Published build" : "Draft build"}</strong>
                    <small>
                      {formatTime(version.createdAt)} · QA {version.visualQAScore ?? "—"}
                    </small>
                  </span>
                  <span className="version-chevron">›</span>
                </button>
              ))}
            </div>
            <div className="action-row">
              <button
                className="primary-action small"
                disabled={busy || !selectedVersion}
                onClick={() => void startPreview()}
              >
                Preview selected <span>→</span>
              </button>
              <button
                className="secondary"
                disabled={busy || !selectedVersion}
                onClick={() => void action("publish")}
              >
                Publish
              </button>
              <button
                className="secondary"
                disabled={busy || !selectedVersion}
                onClick={() => void action("rollback")}
              >
                Rollback
              </button>
              <button
                className="danger subtle"
                disabled={busy || !detail.project.publishedDeploymentId}
                onClick={() => void action("unpublish")}
              >
                Unpublish
              </button>
              {detail.hostedUrl && (
                <a className="button-link" href={detail.hostedUrl} target="_blank" rel="noreferrer">
                  Open published ↗
                </a>
              )}
            </div>
            <div className="edit-divider">
              <span className="eyebrow">ITERATE ON THIS SITE</span>
              <h3>What would you like to change?</h3>
              <textarea
                aria-label="Edit prompt"
                value={editPrompt}
                onChange={(event) => setEditPrompt(event.target.value)}
                rows={3}
              />
              <button
                className="secondary"
                disabled={busy || !editPrompt.trim()}
                onClick={() => void edit()}
              >
                {busy ? "Applying change..." : "Apply edit"} <span>→</span>
              </button>
            </div>
          </section>
        )}

        {error && (
          <div className={`error ${isRateLimited ? "rate-limit" : ""}`} role="alert">
            <div className="error-title">
              <span>!</span>
              <strong>
                {isRateLimited ? "Provider rate limit reached" : "Run needs attention"}
              </strong>
            </div>
            <p>{error}</p>
            {isRateLimited && (
              <p>
                Switch <code>SITES_DEV_AGENT_PROVIDER</code> to <code>mock</code>, restart the
                backend, and continue local validation.
              </p>
            )}
          </div>
        )}
        <div className="telemetry-header">
          <div>
            <span className="eyebrow">OBSERVABILITY</span>
            <h2>Pipeline telemetry</h2>
          </div>
          <div className="telemetry-summary">
            <span>
              <b>{passedTasks}</b> passed
            </span>
            <span>
              <b>{events.length}</b> events
            </span>
            <span className={`status-chip ${runStatus?.toLowerCase() ?? "idle"}`}>
              {runStatus ?? "READY"}
            </span>
          </div>
        </div>
        <section className="telemetry-grid">
          <div className="telemetry-card">
            <div className="card-heading">
              <div>
                <span className="card-kicker">LIVE TRACE</span>
                <h3>Run progress</h3>
              </div>
              <span className={`pulse ${runStatus === "RUNNING" ? "active" : ""}`} />
            </div>
            {events.length === 0 ? (
              <div className="panel-empty">
                <span className="empty-line" />
                <strong>No run started</strong>
                <span>Events will appear here in execution order.</span>
              </div>
            ) : (
              <ol className="events">
                {events.slice(-12).map((event, index) => (
                  <li key={`${event.timestamp}-${index}`}>
                    <span className="event-marker" />
                    <div>
                      <strong>{event.stage}</strong>
                      <span>{event.message}</span>
                    </div>
                    <time>{formatTime(event.timestamp)}</time>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="telemetry-card">
            <div className="card-heading">
              <div>
                <span className="card-kicker">TASK BREAKDOWN</span>
                <h3>Agent intelligence</h3>
              </div>
              <span className="task-count">{intelligence.length} tasks</span>
            </div>
            <div className="intelligence-grid">
              {intelligence.length === 0 && (
                <div className="panel-empty">
                  <strong>No task telemetry yet</strong>
                  <span>Start a generation to inspect each agent task.</span>
                </div>
              )}
              {sortedIntelligence.map((task, index) => (
                <div className="task-item" key={`${task.taskKind}-${index}`}>
                  <div className="task-title">
                    <strong>{taskNames[task.taskKind]}</strong>
                    <span data-status={task.status}>{task.status}</span>
                  </div>
                  <small>
                    {formatProviderName(task.provider)} · {task.model}
                  </small>
                  {task.latencyMs > 0 && (
                    <small>
                      {task.latencyMs} ms · {task.turns} turn{task.turns === 1 ? "" : "s"} ·{" "}
                      {task.toolCalls} tool call{task.toolCalls === 1 ? "" : "s"}
                    </small>
                  )}
                  {task.fallbackUsed && (
                    <small className="warning-text">Agent failed → deterministic fallback</small>
                  )}
                  {task.errorCategory && (
                    <small className="warning-text">{task.errorCategory}</small>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
        {detail?.plans && (
          <details className="plans-disclosure">
            <summary>
              <span>Validated planning inspector</span>
              <small>View structured plan payloads</small>
            </summary>
            <div className="plans">
              {Object.entries(detail.plans).map(([name, plan]) => {
                const task = intelligence.find((item) => item.taskKind === planningTasks[name]);
                const source = task?.fallbackUsed
                  ? "Deterministic Fallback"
                  : task?.attempted
                    ? "Agent"
                    : "Deterministic";
                return (
                  <section key={name}>
                    <strong>{name.charAt(0).toUpperCase() + name.slice(1)}</strong>
                    <small>Source: {source}</small>
                    <pre>{JSON.stringify(plan, null, 2)}</pre>
                  </section>
                );
              })}
            </div>
          </details>
        )}
      </main>

      <section className="preview-panel">
        <div className="preview-header">
          <div>
            <span className="eyebrow">LOCAL OUTPUT</span>
            <h2>Website preview</h2>
          </div>
          {preview ? (
            <span className="preview-live">
              <span className="status-light online" /> Live
            </span>
          ) : (
            <span className="preview-live muted-label">Waiting</span>
          )}
        </div>
        <div className="preview-toolbar">
          <div className="device-switcher">
            {[
              ["Desktop", "100%"],
              ["Tablet", "768px"],
              ["Mobile", "390px"],
            ].map(([label, value]) => (
              <button
                key={label}
                className={width === value ? "selected" : ""}
                onClick={() => setWidth(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {preview && (
            <div className="preview-actions">
              <button
                className="toolbar-button"
                title="Refresh preview"
                onClick={() => setFrameKey((key) => key + 1)}
              >
                ↻
              </button>
              <button className="toolbar-button" onClick={() => void stopPreview()} disabled={busy}>
                Stop
              </button>
              <a className="toolbar-button" href={preview.url} target="_blank" rel="noreferrer">
                Open ↗
              </a>
            </div>
          )}
        </div>
        <div className="frame-wrap">
          {preview ? (
            <iframe
              key={frameKey}
              title="Generated site preview"
              src={preview.url}
              style={{ width }}
            />
          ) : (
            <div className="preview-empty">
              <div className="preview-orbit">
                <span>↗</span>
              </div>
              <span className="eyebrow">NO ACTIVE PREVIEW</span>
              <h2>Your site will appear here</h2>
              <p>Generate a project or select a version, then launch its local preview.</p>
              <div className="preview-checklist">
                <span>
                  <b>01</b> Generate a site
                </span>
                <span>
                  <b>02</b> Select a version
                </span>
                <span>
                  <b>03</b> Start preview
                </span>
              </div>
            </div>
          )}
        </div>
        {instance && (
          <details className="instance-inspector" open>
            <summary>
              <span>Local instance</span>
              <span className="instance-running">
                <span className="status-light online" /> Running
              </span>
            </summary>
            <div className="instance-facts">
              <span>
                <strong>Processes</strong>
                {instance.processCount}
              </span>
              <span>
                <strong>Environment</strong>
                {instance.environmentId}
              </span>
              <span className="full-fact">
                <strong>Workspace</strong>
                <code>{instance.workspacePath}</code>
              </span>
            </div>
            <pre>
              {instance.logs.length
                ? instance.logs.join("\n")
                : "Preview is running; no process output yet."}
            </pre>
          </details>
        )}
        <div className="preview-footer">
          <span>
            Execution: <strong>{executionProvider}</strong>
          </span>
          <span>Port secured locally</span>
        </div>
      </section>
    </div>
  );
}
