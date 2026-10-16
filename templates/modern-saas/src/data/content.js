export const navigation = [
  { label: "Features", to: "/features" },
  { label: "Pricing", to: "/pricing" },
  { label: "About", to: "/about" },
  { label: "Contact", to: "/contact" },
];

export const benefits = [
  {
    icon: "spark",
    title: "One clear operating rhythm",
    description: "Bring priorities, project context, and team updates into a workspace everyone can follow.",
  },
  {
    icon: "layers",
    title: "Built around real workflows",
    description: "Shape flexible views for launches, client delivery, planning cycles, and the work between them.",
  },
  {
    icon: "pulse",
    title: "Progress without the status chase",
    description: "Surface decisions, owners, and next steps so teams can move with less coordination overhead.",
  },
  {
    icon: "shield",
    title: "Ready for growing teams",
    description: "Use thoughtful permissions and shared standards to stay organized as more people join the work.",
  },
];

export const featureGroups = [
  {
    eyebrow: "Plan",
    title: "Turn direction into a workable plan",
    description: "Map outcomes, milestones, and ownership without losing the context behind each decision.",
    items: ["Shared roadmaps", "Flexible project views", "Clear ownership", "Reusable playbooks"],
  },
  {
    eyebrow: "Coordinate",
    title: "Keep teams aligned as work changes",
    description: "Connect updates to the work itself and make handoffs easier to understand across functions.",
    items: ["Focused team spaces", "Decision timelines", "Smart notifications", "Cross-team dependencies"],
  },
  {
    eyebrow: "Improve",
    title: "Learn from every delivery cycle",
    description: "Review patterns, spot friction, and refine the way your team works with lightweight insights.",
    items: ["Progress summaries", "Workflow signals", "Cycle reviews", "Custom dashboards"],
  },
];

export const pricingPlans = [
  {
    name: "Starter",
    price: "$0",
    description: "For individuals and small teams organizing their first shared workflows.",
    features: ["Up to 5 collaborators", "Core project views", "Shared notes", "Community support"],
    cta: "Start with Starter",
  },
  {
    name: "Pro",
    price: "$16",
    suffix: "per user / month",
    description: "For growing teams that need more structure, visibility, and control.",
    features: ["Unlimited collaborators", "Advanced workflows", "Team dashboards", "Priority support"],
    cta: "Choose Pro",
    featured: true,
  },
  {
    name: "Business",
    price: "Custom",
    description: "For organizations coordinating work across multiple teams and programs.",
    features: ["Organization controls", "Custom onboarding", "Workspace governance", "Dedicated support"],
    cta: "Talk to sales",
  },
];

export const faqs = [
  {
    question: "Can this template work for different SaaS products?",
    answer: "Yes. The structure and copy are intentionally broad, so teams can adapt it for software, AI, productivity, and B2B products.",
  },
  {
    question: "Does the template depend on external images?",
    answer: "No. Product visuals, avatars, marks, and icons are created with CSS and inline SVG for reliable rendering.",
  },
  {
    question: "Are the pricing and testimonials real?",
    answer: "No. They are clearly presented as illustrative template content and should be replaced before a real launch.",
  },
  {
    question: "Is the contact form connected to a backend?",
    answer: "No. It demonstrates a polished local success state without sending data anywhere.",
  },
];
