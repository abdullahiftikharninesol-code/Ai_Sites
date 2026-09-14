import type { ProductAcceptanceScenario } from "./product-acceptance-types.js";

export const PRODUCT_ACCEPTANCE_SCENARIOS: readonly ProductAcceptanceScenario[] = [
  {
    id: "business-landing",
    version: 1,
    name: "Business Landing",
    prompt:
      "Create a modern website for a digital consulting company with a home page, services section, testimonials, about section and contact form.",
    expected: {
      pages: ["/", "/services", "/about"],
      runtimeEnabled: true,
      collections: ["contact_submissions", "testimonials"],
      authEnabled: false,
      actions: [],
      form: "contact",
    },
    edits: ["Change the hero heading."],
    tags: ["business", "form"],
  },
  {
    id: "static-portfolio",
    version: 1,
    name: "Static Portfolio",
    prompt:
      "Create a personal software engineer portfolio with projects, skills, experience, about and contact information. No forms or login.",
    expected: {
      pages: ["/"],
      runtimeEnabled: false,
      collections: [],
      authEnabled: false,
      actions: [],
    },
    edits: ["Make the hero more compact and reduce vertical spacing."],
    tags: ["static"],
  },
  {
    id: "restaurant",
    version: 1,
    name: "Restaurant",
    prompt:
      "Create a premium restaurant website with menu categories, testimonials, opening hours and reservation request form.",
    expected: {
      pages: ["/", "/menu"],
      runtimeEnabled: true,
      collections: ["menu_items", "testimonials", "reservation_requests"],
      authEnabled: false,
      actions: [],
      form: "reservation",
    },
    edits: ["Add a customer logo section below the hero."],
    tags: ["catalog", "form"],
  },
  {
    id: "dental-clinic",
    version: 1,
    name: "Dental / Clinic",
    prompt:
      "Create a modern dental clinic website with dentist profiles, services, new-patient information, FAQs and appointment request form.",
    expected: {
      pages: ["/", "/services", "/dentists", "/faq"],
      runtimeEnabled: true,
      collections: ["appointment_requests"],
      authEnabled: false,
      actions: [],
      form: "appointment",
    },
    edits: ["Add a Careers page and navigation link."],
    tags: ["multipage", "form"],
  },
  {
    id: "saas-marketing",
    version: 1,
    name: "SaaS Marketing",
    prompt:
      "Create a SaaS product marketing website with features, integrations, pricing, FAQ, testimonials and contact/demo request. No member login.",
    expected: {
      pages: ["/", "/pricing", "/integrations", "/faq"],
      runtimeEnabled: true,
      collections: ["demo_requests", "testimonials"],
      authEnabled: false,
      actions: [],
      form: "contact",
    },
    edits: ["Remove testimonials."],
    tags: ["multipage", "form"],
  },
  {
    id: "real-estate",
    version: 1,
    name: "Real Estate",
    prompt:
      "Create a real estate website with property listings, property details, location, price, bedrooms, filters, agents and an inquiry form.",
    expected: {
      pages: ["/", "/properties", "/agents"],
      runtimeEnabled: true,
      collections: ["properties", "inquiries"],
      authEnabled: false,
      actions: [],
      form: "inquiry",
    },
    edits: ["Change the hero heading."],
    tags: ["catalog", "form"],
  },
  {
    id: "member-portal",
    version: 1,
    name: "Member Portal",
    prompt:
      "Create a member portal where users can sign up, log in and manage their own private notes from a protected dashboard.",
    expected: {
      pages: ["/", "/dashboard"],
      runtimeEnabled: true,
      collections: ["member_notes"],
      authEnabled: true,
      actions: [],
    },
    edits: ["Modify the dashboard styling without changing authentication."],
    tags: ["auth", "owner"],
  },
  {
    id: "external-action",
    version: 1,
    name: "Auth + External Action",
    prompt:
      "Create a member dashboard where authenticated users can request company insights from a protected external service.",
    expected: {
      pages: ["/", "/dashboard"],
      runtimeEnabled: true,
      collections: [],
      authEnabled: true,
      actions: ["companyInsights.get"],
    },
    edits: ["Make the insights panel more compact without changing the action."],
    tags: ["auth", "action"],
  },
  {
    id: "complex-multipage",
    version: 1,
    name: "Complex Multi-Page",
    prompt:
      "Create a modern consulting company website with home, about, services, case studies, team, resources, FAQ, contact and member login.",
    expected: {
      pages: [
        "/",
        "/about",
        "/services",
        "/case-studies",
        "/team",
        "/resources",
        "/faq",
        "/dashboard",
      ],
      runtimeEnabled: true,
      collections: ["contact_submissions"],
      authEnabled: true,
      actions: [],
      form: "contact",
    },
    edits: ["Add a Careers page and navigation link."],
    tags: ["multipage", "auth", "form"],
  },
  {
    id: "version-stress",
    version: 1,
    name: "Version Stress",
    prompt:
      "Create a member consulting portal with a protected dashboard, private notes and contact form.",
    expected: {
      pages: ["/", "/dashboard"],
      runtimeEnabled: true,
      collections: ["contact_submissions", "member_notes"],
      authEnabled: true,
      actions: [],
    },
    edits: [
      "Change the hero title.",
      "Add a customer logo section below the hero.",
      "Modify dashboard styling and content.",
    ],
    tags: ["versions", "auth", "owner"],
  },
] as const;

export class ProductAcceptanceScenarioRegistry {
  readonly #scenarios = new Map(
    PRODUCT_ACCEPTANCE_SCENARIOS.map((scenario) => [scenario.id, scenario]),
  );
  list(): readonly ProductAcceptanceScenario[] {
    return [...this.#scenarios.values()];
  }
  get(id: string): ProductAcceptanceScenario {
    const scenario = this.#scenarios.get(id);
    if (!scenario) throw new Error(`Unknown product acceptance scenario: ${id}`);
    return scenario;
  }
}
