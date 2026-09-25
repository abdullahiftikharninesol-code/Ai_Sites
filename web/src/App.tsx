import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { ArrowLeft, Copy, ExternalLink, RefreshCw, Send, Sparkles, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  PlaygroundApiClient,
  type JobStatus,
  type ProgressEvent,
  type SiteDetail,
  type SiteSummary,
  type SourceFile,
} from "./api-client";
import { friendlyError } from "./error-messages";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import * as Dialog from "./components/ui/dialog";
import { Skeleton } from "./components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Textarea } from "./components/ui/textarea";
import { Tooltip } from "./components/ui/tooltip";
import { ImageAttachments, attachmentUsageForPrompt, pastedImages, type ImageAttachment } from "./components/image-attachments";

const defaultPrompt = "Build a modern digital consulting company website with Home, Services, About, Testimonials and Contact. Include a working contact form.";
const presets = [
  { id: "business", label: "Business", prompt: `Build a professional website for “BrightFix”, a home repair and maintenance company.

Include a strong hero, services, why choose us, customer testimonials, service areas, project image placeholders, FAQ, contact form and a clear Request a Quote CTA.

Use a clean trustworthy visual style and make it fully responsive.` },
  { id: "landing-page", label: "Landing page", prompt: `Create a modern product landing page for “TaskPilot”, an AI-powered task management tool for small teams.

Include a hero, product benefits, interactive product preview, features, integrations, testimonials, pricing preview, FAQ and final signup CTA.

Use a polished modern SaaS design with subtle animations.` },
  { id: "online-store", label: "Online store", prompt: `Build a premium online store for “North & Loom”, a modern clothing brand.

Create a home page with hero promotion, categories, featured products, product cards, sale badges, newsletter signup and footer.

Also create a product-detail experience with gallery placeholders, sizes, quantity controls and Add to Cart interactions.

Use frontend mock data only.` },
  { id: "dashboard", label: "Dashboard", prompt: `Create an operations dashboard for “PulseOps”.

Include sidebar navigation, KPI cards, revenue analytics, project status charts, recent activity, task management, team performance and responsive tables.

Use realistic mock data and working filters, tabs and dropdowns.` },
  { id: "portfolio", label: "Portfolio", prompt: `Build a premium personal portfolio for a product designer named Alex Morgan.

Include an introduction, selected projects, detailed case-study cards, experience, skills, testimonials, about section and contact CTA.

Use an editorial modern design with strong typography and subtle motion.` },
  { id: "booking", label: "Booking", prompt: `Build a booking website for “Serene Studio”, a wellness and beauty business.

Include services, pricing, specialists, availability, testimonials, FAQ, location, contact details and an interactive appointment-booking flow using frontend state.

Make it mobile-friendly and easy for customers to book.` },
];
type ConnectionState = "loading" | "online" | "offline";
type WorkspaceMode = "PREVIEW" | "CODE";
type Viewport = "desktop" | "tablet" | "mobile";
type ConversationTurn = { id: string; role: "user" | "sites"; text: string; pending?: boolean };
const workflowLabels: Record<string, string> = { QUEUED: "Understanding your request", PLANNING: "Understanding your request", DESIGNING: "Understanding your request", CREATING_ENVIRONMENT: "Preparing your website", GENERATING: "Generating website", BUILDING: "Building", PREVIEW_READY: "Checking", QA_RUNNING: "Checking", SAVING: "Checking", COMPLETED: "Ready", FAILED: "Needs attention" };
const workflowOrder = ["Understanding your request", "Preparing your website", "Generating website", "Building", "Checking", "Ready"];
const editLabels: Record<string, string> = { QUEUED: "Updating", PLANNING: "Updating", DESIGNING: "Updating", CREATING_ENVIRONMENT: "Updating", GENERATING: "Updating", BUILDING: "Building", PREVIEW_READY: "Checking", QA_RUNNING: "Checking", SAVING: "Checking", COMPLETED: "Updated" };
const relativeTime = (value?: string) => {
  if (!value) return "";
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
};
const readableError = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const api = useMemo(() => new PlaygroundApiClient(), []);
  const jobController = useRef<AbortController | undefined>(undefined);
  const editing = useRef(false);
  const requestInFlight = useRef(false);
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [detail, setDetail] = useState<SiteDetail>();
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [editPrompt, setEditPrompt] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [editAttachments, setEditAttachments] = useState<ImageAttachment[]>([]);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [runStatus, setRunStatus] = useState<JobStatus["status"]>();
  const [activeJob, setActiveJob] = useState<JobStatus>();
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ id: string; url: string; versionId: string }>();
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [frameKey, setFrameKey] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("loading");
  const [mode, setMode] = useState<WorkspaceMode>("PREVIEW");
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string>();
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [sitesLoading, setSitesLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<SiteSummary>();
  const [showAllSites, setShowAllSites] = useState(false);

  const addTurns = (turns: readonly Omit<ConversationTurn, "id">[]) =>
    setConversation((current) => [
      ...current,
      ...turns.map((turn, index) => ({ ...turn, id: `${Date.now()}-${current.length + index}` })),
    ]);
  // At most one turn is pending at a time: the reply Sites is still working on.
  const settleTurn = (text: string) =>
    setConversation((current) =>
      current.map((turn) => (turn.pending ? { ...turn, text, pending: false } : turn)),
    );
  const progressPendingTurn = (text: string) =>
    setConversation((current) =>
      current.map((turn) => (turn.pending ? { ...turn, text } : turn)),
    );

  const reloadSites = async () => {
    try {
      setSites(await api.sites());
    } finally {
      setSitesLoading(false);
    }
  };
  const renameSite = async (site: SiteSummary, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === site.name) return;
    try {
      await api.renameSite(site.projectId, trimmed);
      setDetail((current) =>
        current?.project.projectId === site.projectId
          ? { ...current, project: { ...current.project, name: trimmed } }
          : current,
      );
      await reloadSites();
      toast.success("Site renamed");
    } catch (reason) {
      const message = readableError(reason, "Unable to rename this site");
      setError(message);
      toast.error(message);
    }
  };
  useEffect(() => { void Promise.all([reloadSites(), api.health()]).then(([, health]) => setConnection(health.status === "ok" ? "online" : "offline")).catch(() => setConnection("offline")); return () => jobController.current?.abort(); }, []);
  const openSite = async (id: string) => {
    try {
      const value = await api.site(id); const versionId = value.project.latestVersionId ?? value.versions.at(-1)?.versionId;
      setDetail(value); setSelectedVersion(versionId); setFiles([]); setSelectedFile(undefined); setFileContents({}); setError("");
      const active = value.activePreview;
      if (active && active.versionId === versionId) {
        setPreview({ id: active.previewSessionId, url: active.previewUrl, versionId: active.versionId });
      } else if (versionId) {
        setPreview(undefined);
        const restored = await api.preview(id, versionId);
        setPreview({ id: restored.previewSessionId, url: restored.previewUrl, versionId });
      } else {
        setPreview(undefined);
      }
    } catch (reason) { setError(readableError(reason, "Unable to open project")); }
  };
  // Opening a past project has no in-session history to replay, so seed a
  // neutral opening pair. finishSuccess reuses openSite and must not clobber
  // the turns a run just recorded, so seeding lives here instead.
  const openFromList = (id: string) => {
    setConversation([
      { id: "opened-request", role: "user", text: "Opened this site" },
      { id: "opened-reply", role: "sites", text: "Your website is ready to explore. Ask for a change whenever you like." },
    ]);
    navigate(`/sites/${encodeURIComponent(id)}`);
  };
  useEffect(() => {
    const match = /^\/sites\/([^/]+)$/.exec(location.pathname);
    if (!match) return;
    const projectId = decodeURIComponent(match[1]!);
    if (detail?.project.projectId !== projectId) void openSite(projectId);
  }, [location.pathname, detail?.project.projectId]);
  const newRun = () => { navigate("/"); setDetail(undefined); setSelectedVersion(undefined); setPreview(undefined); setMode("PREVIEW"); setError(""); setConversation([]); };
  const startVersionPreview = async (siteId: string, versionId: string) => { if (preview) await api.stopPreview(preview.id); const value = await api.preview(siteId, versionId); setPreview({ id: value.previewSessionId, url: value.previewUrl, versionId }); };
  const followJob = (jobId: string) => new Promise<JobStatus>((resolve, reject) => {
    jobController.current?.abort(); const controller = new AbortController(); jobController.current = controller; setEvents([]); setActiveJob(undefined); setRunStatus("QUEUED");
    let timer: ReturnType<typeof setTimeout>; let done = false; const stopEvents = api.events(jobId, (event) => setEvents((current) => [...current, event].slice(-300)), () => undefined);
    const cleanup = () => { done = true; clearTimeout(timer); stopEvents(); controller.signal.removeEventListener("abort", cancel); }; const cancel = () => { cleanup(); reject(new Error("Stopped following job")); }; controller.signal.addEventListener("abort", cancel, { once: true });
    const poll = () => void api.job(jobId, controller.signal).then((job) => { if (done) return; setActiveJob(job); setRunStatus(job.status); if (editing.current && job.status === "RUNNING") progressPendingTurn(editLabels[job.currentStage] ?? "Updating"); if (job.status === "SUCCEEDED" || job.status === "FAILED") { cleanup(); if (job.status === "FAILED") reject(Object.assign(new Error(job.error?.message ?? "Job failed"), { job })); else resolve(job); } }).catch((reason) => { cleanup(); reject(reason instanceof Error ? reason : new Error("Unable to read job status")); }).finally(() => { if (!done) timer = setTimeout(poll, 500); });
    poll();
  });
  const finishSuccess = async (job: JobStatus, siteId?: string) => { const projectId = siteId ?? job.projectId; await reloadSites(); if (projectId) { await openSite(projectId); navigate(`/sites/${encodeURIComponent(projectId)}`); } if (job.preview && job.versionId) setPreview({ id: job.preview.sessionId, url: job.preview.url, versionId: job.versionId }); };
  const generate = async () => {
    if (requestInFlight.current || prompt.trim().length < 3) return;
    requestInFlight.current = true;
    const request = prompt.trim();
    editing.current = false;
    setBusy(true); setError(""); setActiveJob(undefined); setMode("PREVIEW");
    navigate("/build");
    setConversation([
      { id: "generate-request", role: "user", text: request },
      { id: "generate-reply", role: "sites", text: "Working on it…", pending: true },
    ]);
    try {
      const uploaded = await Promise.all(attachments.map(({ file }) => api.uploadImage(file)));
      const { jobId } = await api.generate(request, uploaded.map(({ id }) => id), uploaded.filter((_, index) => attachments[index] && attachmentUsageForPrompt(attachments[index]!, request) === "REFERENCE").map(({ id }) => id));
      await finishSuccess(await followJob(jobId));
      setAttachments([]);
      settleTurn("Your website is ready to explore. Ask for a change whenever you like.");
    } catch (reason) {
      const job = (reason as { job?: JobStatus }).job; if (job) setActiveJob(job);
      const message = friendlyError(job, readableError(reason, "We couldn't finish this website."));
      setError(message); settleTurn(message);
    } finally { requestInFlight.current = false; setBusy(false); }
  };
  const edit = async () => {
    if (requestInFlight.current || !detail || editPrompt.trim().length < 3) return;
    requestInFlight.current = true;
    const siteId = detail.project.projectId;
    const request = editPrompt.trim();
    editing.current = true;
    setBusy(true); setError(""); setActiveJob(undefined);
    // The request moves into the thread immediately, so the composer clears now.
    addTurns([
      { role: "user", text: request },
      { role: "sites", text: "Working on it…", pending: true },
    ]);
    setEditPrompt("");
    try {
      const uploaded = await Promise.all(editAttachments.map(({ file }) => api.uploadImage(file)));
      const { jobId } = await api.edit(siteId, request, selectedVersion, uploaded.map(({ id }) => id), uploaded.filter((_, index) => editAttachments[index] && attachmentUsageForPrompt(editAttachments[index]!, request) === "REFERENCE").map(({ id }) => id));
      await finishSuccess(await followJob(jobId), siteId);
      setEditAttachments([]);
      settleTurn("Here is your updated website.");
    } catch (reason) {
      const job = (reason as { job?: JobStatus }).job; if (job) setActiveJob(job);
      const message = friendlyError(job, readableError(reason, "We couldn't apply that change."), "EDIT");
      setEditPrompt((current) => current.trim() ? current : request); setError(message); settleTurn(message);
    } finally { requestInFlight.current = false; setBusy(false); }
  };
  const confirmDelete = async () => {
    const site = pendingDelete;
    if (!site) return;
    setPendingDelete(undefined);
    try {
      await api.deleteSite(site.projectId);
      if (detail?.project.projectId === site.projectId) newRun();
      await reloadSites();
      toast.success("Site deleted");
    } catch (reason) {
      const message = readableError(reason, "Unable to delete this site");
      setError(message);
      toast.error(message);
    }
  };
  const loadSourceFiles = async () => { if (!detail || !selectedVersion) return; setSourceLoading(true); setSourceError(""); try { const value = await api.sourceFiles(detail.project.projectId, selectedVersion); setFiles(value.files); const firstText = value.files.find((file) => !file.encoding); setSelectedFile((current) => current && value.files.some((file) => file.path === current) ? current : firstText?.path); } catch (reason) { setSourceError(readableError(reason, "Unable to load generated source")); } finally { setSourceLoading(false); } };
  useEffect(() => { if (detail && selectedVersion) void loadSourceFiles(); }, [detail?.project.projectId, selectedVersion]);
  useEffect(() => { if (!detail || !selectedVersion || !selectedFile || files.find((file) => file.path === selectedFile)?.encoding) return; const key = `${selectedVersion}:${selectedFile}`; if (fileContents[key] !== undefined) return; setSourceLoading(true); setSourceError(""); void api.sourceFile(detail.project.projectId, selectedVersion, selectedFile).then((value) => setFileContents((current) => ({ ...current, [key]: value.content }))).catch((reason) => setSourceError(readableError(reason, "Unable to load source file"))).finally(() => setSourceLoading(false)); }, [detail?.project.projectId, selectedVersion, selectedFile, files]);
  const currentVersion = detail?.versions.find((version) => version.versionId === selectedVersion); const currentSource = selectedVersion && selectedFile ? fileContents[`${selectedVersion}:${selectedFile}`] : undefined; const currentStage = activeJob?.currentStage ?? events.at(-1)?.stage ?? "QUEUED";
  return <div className="sites-module">
    <header className="sites-module-header">
      <button className="sites-module-title" onClick={newRun} aria-label="Open Sites"><span className="sites-module-mark">S</span><span><strong>Sites</strong><small>Website builder</small></span></button>
      <div className="sites-module-actions"><span className={`connection-state ${connection}`} title="Sites backend availability"><i />{connection === "online" ? "Ready" : connection === "loading" ? "Connecting" : "Offline"}</span></div>
    </header>
    <main className="sites-content">
      {!detail && !busy && <StartScreen sites={sites} sitesLoading={sitesLoading} busy={busy} onNew={newRun} onOpen={openFromList} onRename={(site, name) => void renameSite(site, name)} onDelete={setPendingDelete} showAll={showAllSites} setShowAll={setShowAllSites} prompt={prompt} setPrompt={setPrompt} attachments={attachments} setAttachments={setAttachments} onGenerate={() => void generate()} />}
      {!detail && busy && <GenerationView currentStage={currentStage} runStatus={runStatus} viewport={viewport} setViewport={setViewport} />}
      {detail && <ProjectWorkspace detail={detail} currentVersion={currentVersion} onBack={newRun} mode={mode} setMode={setMode} viewport={viewport} setViewport={setViewport} preview={preview} frameKey={frameKey} refreshPreview={() => setFrameKey((key) => key + 1)} onStartPreview={() => detail && selectedVersion ? void startVersionPreview(detail.project.projectId, selectedVersion) : undefined} files={files} selectedFile={selectedFile} setSelectedFile={setSelectedFile} currentSource={currentSource} sourceLoading={sourceLoading} sourceError={sourceError} editPrompt={editPrompt} setEditPrompt={setEditPrompt} editAttachments={editAttachments} setEditAttachments={setEditAttachments} onEdit={() => void edit()} busy={busy} conversation={conversation} />}
      {error && <ErrorNotice message={error} job={activeJob} operation={detail ? "EDIT" : "GENERATE"} onRetry={() => void (detail ? edit() : generate())} canRetry={!busy && (detail ? editPrompt.trim().length >= 3 : prompt.trim().length >= 3)} />}
    </main>
    {pendingDelete && <ConfirmDialog title={`Delete ${pendingDelete.name}?`} body="This permanently removes the site and its generated source. This cannot be undone." confirmLabel="Delete site" onCancel={() => setPendingDelete(undefined)} onConfirm={() => void confirmDelete()} />}
  </div>;
}

const VISIBLE_SITES = 6;

function SitesProjects({ sites, sitesLoading, busy, onNew, onOpen, onRename, onDelete, showAll, setShowAll }: { sites: SiteSummary[]; sitesLoading: boolean; busy: boolean; onNew: () => void; onOpen: (id: string) => void; onRename: (site: SiteSummary, name: string) => void; onDelete: (site: SiteSummary) => void; showAll: boolean; setShowAll: (value: boolean) => void }) {
  const visible = showAll ? sites : sites.slice(0, VISIBLE_SITES);
  return <section className="sites-projects" aria-label="Recent sites">
    <div className="sites-projects-heading">
      <h2>Recent sites</h2>
      <button className="new-project" onClick={onNew}>＋ New site</button>
    </div>
    {sitesLoading ? <div className="sites-projects-empty" aria-label="Loading your sites"><Skeleton className="sites-list-skeleton" /></div>
      : sites.length ? <>
        <div className="sites-project-grid">{visible.map((site) => <SiteCard key={site.projectId} site={site} busy={busy} onOpen={onOpen} onRename={onRename} onDelete={onDelete} />)}</div>
        {sites.length > VISIBLE_SITES && <button className="view-all" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `View all ${sites.length}`}</button>}
      </> : <div className="sites-projects-empty">No sites yet. Describe what you want above and Sites will build it.</div>}
  </section>;
}

function SiteCard({ site, busy, onOpen, onRename, onDelete }: { site: SiteSummary; busy: boolean; onOpen: (id: string) => void; onRename: (site: SiteSummary, name: string) => void; onDelete: (site: SiteSummary) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuOpensUp, setMenuOpensUp] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(site.name);
  const menu = useRef<HTMLDivElement>(null);
  const menuList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);
  useEffect(() => {
    if (!menuOpen) { setMenuOpensUp(false); return; }
    const positionMenu = () => {
      const trigger = menu.current?.getBoundingClientRect();
      const menuHeight = menuList.current?.offsetHeight ?? 112;
      if (trigger) setMenuOpensUp(trigger.bottom + menuHeight + 8 > window.innerHeight);
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => { window.removeEventListener("resize", positionMenu); window.removeEventListener("scroll", positionMenu, true); };
  }, [menuOpen]);
  const commit = (event: FormEvent) => { event.preventDefault(); onRename(site, draft); setRenaming(false); };
  const status = site.latestVersion ? "Ready" : "In progress";
  return <Card className="site-project-card">
    {renaming
      ? <form className="rename-form" onSubmit={commit}>
          <label className="visually-hidden" htmlFor={`rename-${site.projectId}`}>Site name</label>
          <input id={`rename-${site.projectId}`} autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setDraft(site.name); setRenaming(false); } }} />
          <button type="submit" className="rename-save">Save</button>
        </form>
      : <button className="site-project-open" onClick={() => onOpen(site.projectId)}>
          <span className="project-avatar" aria-hidden="true">{site.name.slice(0, 1).toUpperCase()}</span>
          <span><strong>{site.name}</strong><small>{relativeTime(site.updatedAt)}</small></span>
        </button>}
    <div className="card-meta">
      <span className={`card-status ${status === "Ready" ? "ready" : "pending"}`}>{status}</span>
      <div className="card-menu" ref={menu}>
        <button className="menu-trigger" aria-label={`Actions for ${site.name}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy} onClick={() => setMenuOpen((open) => !open)}>⋯</button>
        {menuOpen && <div className={`menu-list${menuOpensUp ? " menu-list-up" : ""}`} ref={menuList} role="menu">
          <button role="menuitem" onClick={() => { setMenuOpen(false); onOpen(site.projectId); }}>Open</button>
          <button role="menuitem" onClick={() => { setMenuOpen(false); setDraft(site.name); setRenaming(true); }}>Rename</button>
          <button role="menuitem" className="menu-danger" onClick={() => { setMenuOpen(false); onDelete(site); }}>Delete</button>
        </div>}
      </div>
    </div>
  </Card>;
}

function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }: { title: string; body: string; confirmLabel: string; onCancel: () => void; onConfirm: () => void }) {
  return <Dialog.Dialog open title={title} description={body} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <div className="confirm-actions">
        <Dialog.DialogClose asChild><Button onClick={onCancel}>Cancel</Button></Dialog.DialogClose>
        <Button className="danger-button" autoFocus onClick={onConfirm}>{confirmLabel}</Button>
      </div>
  </Dialog.Dialog>;
}
function StartScreen({ sites, sitesLoading, busy, onNew, onOpen, onRename, onDelete, showAll, setShowAll, prompt, setPrompt, attachments, setAttachments, onGenerate }: { sites: SiteSummary[]; sitesLoading: boolean; busy: boolean; onNew: () => void; onOpen: (id: string) => void; onRename: (site: SiteSummary, name: string) => void; onDelete: (site: SiteSummary) => void; showAll: boolean; setShowAll: (value: boolean) => void; prompt: string; setPrompt: (value: string) => void; attachments: ImageAttachment[]; setAttachments: (files: ImageAttachment[]) => void; onGenerate: () => void }) { const submit = (event: FormEvent) => { event.preventDefault(); onGenerate(); }; return <section className="start-screen"><div className="start-copy"><span className="eyebrow">SITES</span><h1>What do you want to build?</h1><p>Describe your website and Sites will build it for you.</p></div><PromptComposer value={prompt} setValue={setPrompt} attachments={attachments} setAttachments={setAttachments} onSubmit={submit} buttonLabel="Generate" placeholder="Build a modern SaaS website for an AI meeting assistant..." /><div className="example-section"><div className="section-label"><span>Try an example</span><small>Or write your own prompt</small></div><div className="preset-grid">{presets.map((preset) => <button className="preset-chip" key={preset.id} onClick={() => setPrompt(preset.prompt)}><span>{preset.label}</span><i>↗</i></button>)}</div></div><div className="start-note"><span>✦</span><span>Every site includes a responsive layout, live preview and readable source code.</span></div><SitesProjects sites={sites} sitesLoading={sitesLoading} busy={busy} onNew={onNew} onOpen={onOpen} onRename={onRename} onDelete={onDelete} showAll={showAll} setShowAll={setShowAll} /></section>; }
function PromptComposer({ value, setValue, attachments, setAttachments, onSubmit, buttonLabel, placeholder }: { value: string; setValue: (value: string) => void; attachments: ImageAttachment[]; setAttachments: (files: ImageAttachment[]) => void; onSubmit: (event: FormEvent) => void; buttonLabel: string; placeholder: string }) {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); onSubmit(event); } };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => { const images = pastedImages([...event.clipboardData.files]); if (!images.length) return; event.preventDefault(); setAttachments([...attachments, ...images]); };
  return <form className="prompt-composer" onSubmit={onSubmit}><Textarea aria-label={placeholder} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} placeholder={placeholder} rows={5} /><ImageAttachments attachments={attachments} setAttachments={setAttachments} prompt={value} /><div className="composer-footer"><span /><Button className="primary-button" type="submit">{buttonLabel}<Send size={13} aria-hidden="true" /></Button></div></form>;
}
function GenerationView({ currentStage, runStatus, viewport, setViewport }: { currentStage: string; runStatus?: JobStatus["status"]; viewport: Viewport; setViewport: (value: Viewport) => void }) {
  const currentLabel = workflowLabels[currentStage] ?? "Generating website";
  const activeIndex = runStatus === "SUCCEEDED" ? workflowOrder.length - 1 : Math.max(0, workflowOrder.indexOf(currentLabel));
  return <section className="generating-screen">
    <div className="generation-card">
      <div className="generation-title"><span className="loader" /><div><span className="eyebrow">WORKING ON IT</span><h1>Building your website</h1><p>We’re turning your idea into a real, responsive site.</p></div></div>
      <div className="friendly-steps">{workflowOrder.map((label, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "current" : "pending";
        return <div className={`friendly-step ${state}`} key={label}><span aria-hidden="true">{state === "done" ? "✓" : state === "current" ? "•" : "○"}</span><strong>{label}</strong></div>;
      })}</div>
    </div>
    <div className="waiting-preview">
      <div className="preview-topline"><span>Live preview</span><span className="preview-badge">Preparing</span></div>
      <div className="preview-placeholder"><div className="placeholder-window"><span /><span /><span /></div><strong>Your website will appear here</strong><small>Preview becomes available when the build is ready.</small></div>
      <ViewportSwitcher viewport={viewport} setViewport={setViewport} disabled />
    </div>
  </section>;
}
function ProjectWorkspace({ detail, currentVersion, onBack, mode, setMode, viewport, setViewport, preview, frameKey, refreshPreview, onStartPreview, files, selectedFile, setSelectedFile, currentSource, sourceLoading, sourceError, editPrompt, setEditPrompt, editAttachments, setEditAttachments, onEdit, busy, conversation }: { detail: SiteDetail; currentVersion?: SiteDetail["versions"][number]; onBack: () => void; mode: WorkspaceMode; setMode: (mode: WorkspaceMode) => void; viewport: Viewport; setViewport: (viewport: Viewport) => void; preview?: { id: string; url: string; versionId: string }; frameKey: number; refreshPreview: () => void; onStartPreview: () => void; files: SourceFile[]; selectedFile?: string; setSelectedFile: (path?: string) => void; currentSource?: string; sourceLoading: boolean; sourceError: string; editPrompt: string; setEditPrompt: (value: string) => void; editAttachments: ImageAttachment[]; setEditAttachments: (files: ImageAttachment[]) => void; onEdit: () => void; busy: boolean; conversation: ConversationTurn[] }) {
  const status = busy ? "Updating" : currentVersion?.browserQAStatus === "FAILED" || currentVersion?.buildStatus === "FAILED" ? "Needs attention" : currentVersion ? "Saved" : "Ready";
  return <section className="workspace-screen">
    <header className="workspace-header">
      <div className="workspace-title">
        <Button className="back-button" onClick={onBack}><ArrowLeft size={13} aria-hidden="true" /> <span>Sites</span></Button>
        <h1>{detail.project.name}</h1>
      </div>
      <StatusPill status={status} />
    </header>
    <div className="workspace-body">
      <ConversationPanel conversation={conversation} editPrompt={editPrompt} setEditPrompt={setEditPrompt} attachments={editAttachments} setAttachments={setEditAttachments} onEdit={onEdit} busy={busy} />
      <section className="canvas">
        <div className="canvas-header">
          <Tabs value={mode} onValueChange={(value) => setMode(value as WorkspaceMode)}>
            <TabsList className="mode-switcher" aria-label="Workspace view">
              <TabsTrigger className={mode === "PREVIEW" ? "active" : ""} value="PREVIEW">Preview</TabsTrigger>
              <TabsTrigger className={mode === "CODE" ? "active" : ""} value="CODE">Code</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "PREVIEW" ? <ViewportSwitcher viewport={viewport} setViewport={setViewport} disabled={!preview} /> : <span className="readonly-label">Read-only source</span>}
        </div>
        {mode === "PREVIEW"
          ? <PreviewPanel preview={preview} frameKey={frameKey} viewport={viewport} onRefresh={refreshPreview} onStart={onStartPreview} busy={busy} />
          : <CodePanel files={files} selectedFile={selectedFile} setSelectedFile={setSelectedFile} content={currentSource} loading={sourceLoading} error={sourceError} />}
      </section>
    </div>
  </section>;
}
function ConversationPanel({ conversation, editPrompt, setEditPrompt, attachments, setAttachments, onEdit, busy }: { conversation: ConversationTurn[]; editPrompt: string; setEditPrompt: (value: string) => void; attachments: ImageAttachment[]; setAttachments: (files: ImageAttachment[]) => void; onEdit: () => void; busy: boolean }) {
  const submit = (event: FormEvent) => { event.preventDefault(); onEdit(); };
  const pasteImage = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = pastedImages([...event.clipboardData.files]);
    if (!images.length) return;
    event.preventDefault();
    setAttachments([...attachments, ...images]);
  };
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => { thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" }); }, [conversation]);
  return <aside className="conversation">
    <div className="conversation-heading"><span className="eyebrow">CONVERSATION</span><h2>Keep shaping it</h2></div>
    <div className="messages" ref={thread}>
      {conversation.map((turn) => <div key={turn.id} className={`message ${turn.role === "user" ? "user-message" : "sites-message"}`}>
        <span className={`message-avatar${turn.role === "user" ? "" : " sites-avatar"}`}>{turn.role === "user" ? "You" : "S"}</span>
        <div>
          <small>{turn.role === "user" ? "You asked" : "Sites"}</small>
          <p>{turn.text}{turn.pending ? <i className="typing-dots" aria-hidden="true"><b /><b /><b /></i> : null}</p>
        </div>
      </div>)}
    </div>
    <form className="edit-composer" onSubmit={submit}>
      <Textarea aria-label="Ask Sites for a change" value={editPrompt} onChange={(event) => setEditPrompt(event.target.value)} onPaste={pasteImage} placeholder="Ask Sites for a change..." rows={4} />
      <ImageAttachments attachments={attachments} setAttachments={setAttachments} prompt={editPrompt} />
      <div><span>Describe a visual or content change</span><Button className="send-button" disabled={busy || editPrompt.trim().length < 3} type="submit">{busy ? "Updating…" : "Send change"}<Send size={13} aria-hidden="true" /></Button></div>
    </form>
  </aside>;
}
function PreviewPanel({ preview, frameKey, viewport, onRefresh, onStart, busy }: { preview?: { id: string; url: string; versionId: string }; frameKey: number; viewport: Viewport; onRefresh: () => void; onStart: () => void; busy: boolean }) {
  return <div className="preview-area">
    <div className="preview-toolbar">
      <div><span className={`live-indicator ${preview ? "on" : ""}`} />{preview ? busy ? "Live preview · updating" : "Live preview" : "Preview preparing"}</div>
      <div className="preview-toolbar-actions">
        <Tooltip content="Refresh preview"><Button onClick={onRefresh} disabled={!preview} aria-label="Refresh preview"><RefreshCw size={13} aria-hidden="true" /></Button></Tooltip>
        <a
          className={`toolbar-link${preview ? "" : " disabled"}`}
          href={preview?.url ?? "#"}
          target="_blank"
          rel="noreferrer"
          title="Open the generated site in a new tab"
          aria-disabled={preview ? undefined : true}
          onClick={(event) => { if (!preview) event.preventDefault(); }}
        >Open <ExternalLink size={12} aria-hidden="true" /></a>
      </div>
    </div>
    <div className="iframe-stage">
      {preview
        ? <iframe key={frameKey} title="Generated website preview" src={preview.url} className={`viewport-${viewport}`} />
        : <div className="empty-preview">
            <div className="empty-preview-icon" aria-hidden="true"><Sparkles size={20} /></div>
            <h2>Preparing your preview</h2>
            <p>The live preview opens automatically once the build is ready.</p>
            <button className="primary-button" onClick={onStart}>Retry preview <span>→</span></button>
          </div>}
    </div>
  </div>;
}
function ViewportSwitcher({ viewport, setViewport, disabled = false }: { viewport: Viewport; setViewport: (viewport: Viewport) => void; disabled?: boolean }) { return <div className="viewport-switcher" role="group" aria-label="Preview size">{(["desktop", "tablet", "mobile"] as const).map((size) => <button key={size} className={viewport === size ? "active" : ""} disabled={disabled} aria-pressed={viewport === size} title={`Preview at ${size} width`} onClick={() => setViewport(size)}>{size.charAt(0).toUpperCase() + size.slice(1)}</button>)}</div>; }
type TreeEntry = { path: string; label: string; folder: boolean; children?: TreeEntry[] };
function CodePanel({ files, selectedFile, setSelectedFile, content, loading, error }: { files: SourceFile[]; selectedFile?: string; setSelectedFile: (path?: string) => void; content?: string; loading: boolean; error: string }) { const copySource = async () => { if (!content) return; await navigator.clipboard?.writeText(content); toast.success("Source copied"); }; return <div className="code-area"><aside className="file-tree"><div className="file-tree-heading">FILES <span>{files.filter((file) => !file.encoding).length}</span></div>{loading && !files.length ? <div className="tree-message">Loading files…</div> : error && !files.length ? <div className="tree-message error-text">{error}</div> : buildFileTree(files.filter((file) => !file.encoding)).map((entry) => <FileTreeEntry entry={entry} key={entry.path} selectedFile={selectedFile} setSelectedFile={setSelectedFile} />)}</aside><section className="code-viewer"><div className="code-header"><span>{selectedFile ?? "Select a file"}</span>{selectedFile && <Button onClick={() => void copySource()}><Copy size={12} aria-hidden="true" /> Copy</Button>}</div>{error && files.length ? <div className="code-empty error-text">{error}</div> : !selectedFile ? <div className="code-empty">Select a source file to inspect it.</div> : loading && content === undefined ? <div className="code-empty">Loading source…</div> : <pre className="source-code" aria-label={`${selectedFile} source code`}><code>{(content ?? "").split("\n").map((line, index) => <span className="code-line" key={index}><i>{index + 1}</i><b>{highlightLine(line, selectedFile)}</b></span>)}</code></pre>}</section></div>; }
function buildFileTree(files: SourceFile[]): TreeEntry[] { const root: TreeEntry[] = []; for (const file of files.slice().sort((a, b) => a.path.localeCompare(b.path))) { let current = root; const parts = file.path.split("/"); parts.forEach((part, index) => { const path = parts.slice(0, index + 1).join("/"); let entry = current.find((item) => item.path === path); if (!entry) { entry = { path, label: part, folder: index < parts.length - 1, ...(index < parts.length - 1 ? { children: [] } : {}) }; current.push(entry); } current = entry.children ?? []; }); } return root; }
function FileTreeEntry({ entry, selectedFile, setSelectedFile }: { entry: TreeEntry; selectedFile?: string; setSelectedFile: (path?: string) => void }) { const [open, setOpen] = useState(true); if (entry.folder) return <div className="tree-folder"><button onClick={() => setOpen((value) => !value)}><span>{open ? "⌄" : "›"}</span> {entry.label}</button>{open && <div>{entry.children?.map((child) => <FileTreeEntry entry={child} key={child.path} selectedFile={selectedFile} setSelectedFile={setSelectedFile} />)}</div>}</div>; return <button className={`tree-file ${selectedFile === entry.path ? "selected" : ""}`} onClick={() => setSelectedFile(entry.path)}><span>•</span>{entry.label}</button>; }
function highlightLine(line: string, path = "") { const parts = line.split(/(\/\/.*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|export|default|import|from|interface|type|class|extends|if|else|true|false|null|undefined|async|await)\b|\b\d+(?:\.\d+)?\b)/g); return parts.map((part, index) => { const kind = /^\/\//.test(part) || /^\/\*/.test(part) ? "comment" : /^(?:const|let|var|function|return|export|default|import|from|interface|type|class|extends|if|else|true|false|null|undefined|async|await)$/.test(part) ? "keyword" : /^\d/.test(part) ? "number" : /^(?:["'`])/.test(part) ? "string" : path.endsWith(".css") && /--?[a-z-]+/.test(part) ? "property" : ""; return <span className={kind} key={`${index}-${part}`}>{part}</span>; }); }
function StatusPill({ status }: { status: string }) { return <span className={`status-pill ${status.toLowerCase().replace(" ", "-")}`}><i />{status}</span>; }
function ErrorNotice({ message, job, operation, onRetry, canRetry }: { message: string; job?: JobStatus; operation: "GENERATE" | "EDIT"; onRetry: () => void; canRetry: boolean }) {
  const failure = job?.error;
  return <section className="error-notice" role="alert"><div className="error-icon">!</div><div>
    <h2>{operation === "EDIT" ? "We couldn't apply that change" : "We couldn't finish this website"}</h2>
    <p>{message}</p>
    {failure && <small>
      {failure.status !== undefined && <>HTTP {failure.status} · </>}
      {failure.providerCode ?? failure.code}
      {failure.providerParam && <> · {failure.providerParam}</>}
      {failure.requestId && <> · Request {failure.requestId}</>}
    </small>}
    <div className="error-actions"><button className="primary-button small" disabled={!canRetry} onClick={onRetry}>Try again</button></div>
    {failure?.retryable && <small>This issue may resolve if you try again shortly.</small>}
  </div></section>;
}
