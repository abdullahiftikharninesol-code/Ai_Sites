import type { ExecutionProvider } from "../../execution/execution-provider.js";
import { createHash } from "node:crypto";

export const FUNCTIONAL_RUNTIME_PATH = "src/sites-ui/functional.tsx";
/** Layout-neutral, React-only managed source. No credentials, network or backend-success simulation. */
export const FUNCTIONAL_RUNTIME_SOURCE = String.raw`import { useId, useRef, useState, useSyncExternalStore, type ReactNode, type FormEvent } from "react";
export interface Product { id: string; name: string; price: number; image?: string; category?: string }
export interface CartItem { key: string; product: Product; quantity: number; size: string }
const cartStorageKey = "sites-demo-cart-v1";
let cartState: { items: CartItem[]; isOpen: boolean } = { items: [], isOpen: false };
const listeners = new Set<() => void>();
try {
  const stored: unknown = JSON.parse(sessionStorage.getItem(cartStorageKey) || "[]");
  if (Array.isArray(stored)) cartState.items = stored.filter((item): item is CartItem =>
    !!item && typeof item.key === "string" && typeof item.product?.id === "string" && typeof item.product?.name === "string" &&
    typeof item.product?.price === "number" && Number.isFinite(item.product.price) && typeof item.size === "string" &&
    Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 999).slice(0, 100);
} catch { /* Disabled storage or invalid demo data never breaks the page. */ }
function updateCart(next: typeof cartState) {
  cartState = next;
  try { sessionStorage.setItem(cartStorageKey, JSON.stringify(next.items)); } catch { /* In-memory demo remains usable. */ }
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => cartState;
const clamp = (value: number) => Math.max(1, Math.min(999, Math.trunc(Number.isFinite(value) ? value : 1)));
export function useCart() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { ...state, count: state.items.reduce((sum, item) => sum + item.quantity, 0),
    add(product: Product, quantity = 1, size = "") {
      if (!product.id || !product.name || !Number.isFinite(product.price)) throw new Error("Cart requires a valid demo product");
      const key = JSON.stringify([product.id, size]);
      const existing = cartState.items.find(item => item.key === key);
      const items = existing ? cartState.items.map(item => item.key === key ? { ...item, quantity: clamp(item.quantity + quantity) } : item)
        : [...cartState.items, { key, product, quantity: clamp(quantity), size }];
      updateCart({ ...cartState, items });
    },
    openCart() { updateCart({ ...cartState, isOpen: true }); },
    closeCart() { updateCart({ ...cartState, isOpen: false }); },
    remove(key: string) { updateCart({ ...cartState, items: cartState.items.filter(item => item.key !== key) }); },
  };
}
export function CartTrigger({ className = "" }: { className?: string }) {
  const cart = useCart();
  return <button type="button" className={className} data-sites-action="cart.open" aria-expanded={cart.isOpen} aria-controls="sites-demo-cart" onClick={cart.openCart}>Cart ({cart.count})</button>;
}
export function CartPanel({ className = "" }: { className?: string }) {
  const cart = useCart();
  return <aside id="sites-demo-cart" hidden={!cart.isOpen} className={className} aria-label="Shopping cart" data-sites-capability="cart">
    <h2>Your cart</h2><p>Frontend demo cart — no checkout or payment.</p>
    {cart.items.length ? <ul>{cart.items.map(item => <li key={item.key}><strong>{item.product.name}</strong><span> Size {item.size || "Default"} · Quantity {item.quantity}</span><button type="button" onClick={() => cart.remove(item.key)}>Remove {item.product.name}</button></li>)}</ul> : <p>Your cart is empty.</p>}
    <button type="button" onClick={cart.closeCart}>Close cart</button>
  </aside>;
}
export function AddToCartButton({ product, quantity = 1, size = "", className = "" }: { product: Product; quantity?: number; size?: string; className?: string }) {
  const cart = useCart(); const [added, setAdded] = useState(false);
  return <><button type="button" className={className} onClick={() => { cart.add(product, quantity, size); setAdded(true); }}>Add to Cart</button>{added && <p role="status">Added to demo cart: {product.name}</p>}</>;
}
export function useQuantity(initial = 1) {
  const [quantity, set] = useState(clamp(initial));
  return { quantity, setQuantity: (value: number) => set(clamp(value)), increase: () => set(value => clamp(value + 1)), decrease: () => set(value => clamp(value - 1)) };
}
export function QuantityControl({ value, onChange, className = "" }: { value: number; onChange: (value: number) => void; className?: string }) {
  return <div className={className} data-sites-capability="quantity"><button type="button" aria-label="Decrease quantity" disabled={value <= 1} onClick={() => onChange(clamp(value - 1))}>−</button><label>Quantity<input type="number" name="quantity" aria-label="Quantity" min="1" max="999" value={value} onChange={event => onChange(clamp(Number(event.target.value)))}/></label><button type="button" aria-label="Increase quantity" onClick={() => onChange(clamp(value + 1))}>+</button></div>;
}
export function SizeSelector({ options, value, onChange, className = "" }: { options: string[]; value: string; onChange: (value: string) => void; className?: string }) {
  return <label className={className}>Size<select data-sites-capability="size" name="size" aria-label="Size" value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select></label>;
}
export function ProductGallery({ images, className = "" }: { images: { src: string; alt: string }[]; className?: string }) {
  const [selected, setSelected] = useState(0); const image = images[selected] || images[0];
  if (!image) return null;
  return <div className={className} data-sites-capability="gallery"><img data-sites-gallery-active src={image.src} alt={image.alt}/><div>{images.map((item, index) => <button type="button" key={index} aria-label={"View image " + (index + 1)} aria-pressed={selected === index} onClick={() => setSelected(index)}><img src={item.src} alt={"Thumbnail " + (index + 1)}/></button>)}</div></div>;
}
export function useProductFilter<T extends { id: string; name: string; category?: string }>(products: readonly T[]) {
  const [query, setQuery] = useState(""); const [category, setCategory] = useState("All");
  const visible = products.filter(product => (category === "All" || product.category === category) && product.name.toLowerCase().includes(query.trim().toLowerCase()));
  return { query, setQuery, category, setCategory, visible, categories: ["All", ...new Set(products.map(product => product.category).filter((value): value is string => !!value))] };
}
export function CategoryFilter({ options, value, onChange, className = "" }: { options: string[]; value: string; onChange: (value: string) => void; className?: string }) {
  return <label className={className}>Category<select name="category" aria-label="Category" data-sites-capability="category-filter" value={value} onChange={event => onChange(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select></label>;
}
export function ProductSearch({ products, className = "" }: { products: { id: string; name: string; category?: string }[]; className?: string }) {
  const filter = useProductFilter(products);
  return <section className={className} data-sites-capability="search"><label>Search<input type="search" name="search" aria-label="Search" value={filter.query} onChange={event => filter.setQuery(event.target.value)}/></label><div role="status">{filter.visible.length} results</div><ul>{filter.visible.map(product => <li key={product.id}>{product.name}</li>)}</ul></section>;
}
export function useToggle(initial = false) { const [open, setOpen] = useState(initial); return { open, toggle: () => setOpen(value => !value), close: () => setOpen(false), show: () => setOpen(true) }; }
export function MobileNav({ items, className = "" }: { items: { label: string; href: string }[]; className?: string }) {
  const menu = useToggle(); const id = useId();
  return <div className={className} data-sites-capability="mobile-nav"><button type="button" aria-expanded={menu.open} aria-controls={id} onClick={menu.toggle}>Menu</button><nav id={id} hidden={!menu.open} aria-label="Mobile navigation">{items.map(item => <a key={item.href} href={item.href} onClick={menu.close}>{item.label}</a>)}</nav></div>;
}
export function Tabs({ items, className = "" }: { items: { id: string; label: string; content: ReactNode }[]; className?: string }) {
  const [selected, setSelected] = useState(items[0]?.id); const base = useId();
  return <section className={className} data-sites-capability="tabs"><div role="tablist">{items.map(item => <button key={item.id} id={base + item.id + "-tab"} type="button" role="tab" aria-selected={selected === item.id} aria-controls={base + item.id} onClick={() => setSelected(item.id)}>{item.label}</button>)}</div>{items.map(item => <div role="tabpanel" key={item.id} id={base + item.id} aria-labelledby={base + item.id + "-tab"} hidden={selected !== item.id}>{item.content}</div>)}</section>;
}
export function Accordion({ items, className = "" }: { items: { id: string; label: string; content: ReactNode }[]; className?: string }) {
  return <section className={className} data-sites-capability="accordion">{items.map(item => <details key={item.id}><summary>{item.label}</summary>{item.content}</details>)}</section>;
}
export function DemoDialog({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <div className={className} data-sites-capability="dialog"><button type="button" onClick={() => dialog.current?.showModal()}>{label}</button><dialog ref={dialog} aria-label={label}>{children}<button type="button" onClick={() => dialog.current?.close()}>Close dialog</button></dialog></div>;
}
function useDemoSubmission() {
  const [submitted, setSubmitted] = useState(false);
  return { submitted, submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (event.currentTarget.reportValidity()) setSubmitted(true); } };
}
export function NewsletterSignup({ className = "" }: { className?: string }) {
  const demo = useDemoSubmission(); const id = useId();
  return <form className={className} data-sites-capability="newsletter" data-sites-demo-form onSubmit={demo.submit}><label htmlFor={id}>Newsletter email</label><input id={id} name="email" type="email" required/><button type="submit">Subscribe</button><p>Demo only — no subscription or email is sent.</p>{demo.submitted && <p role="status">Demo signup recorded in this view only. You have not been subscribed.</p>}</form>;
}
export function DemoForm({ label = "Contact", className = "" }: { label?: string; className?: string }) {
  const demo = useDemoSubmission(); const id = useId();
  return <form className={className} aria-label={label} data-sites-capability="form" data-sites-demo-form onSubmit={demo.submit}><label htmlFor={id + "name"}>Name</label><input id={id + "name"} name="name" required/><label htmlFor={id + "email"}>Email</label><input id={id + "email"} name="email" type="email" required/><label htmlFor={id + "message"}>Message</label><textarea id={id + "message"} name="message" required/><button type="submit">Send demo message</button><p>Demo only — nothing is sent or stored remotely.</p>{demo.submitted && <p role="status">Demo message validated in this view only. Nothing was sent.</p>}</form>;
}
`;
export function functionalCartStorageKey(siteId: string): string {
  return "sites-demo-cart-v1:" + createHash("sha256").update(siteId).digest("hex").slice(0, 32);
}
export async function materializeFunctionalRuntime(execution: Pick<ExecutionProvider, "writeFile">, environmentId: string, siteId = environmentId): Promise<void> {
  await execution.writeFile(environmentId, FUNCTIONAL_RUNTIME_PATH, FUNCTIONAL_RUNTIME_SOURCE.replace('"sites-demo-cart-v1"', JSON.stringify(functionalCartStorageKey(siteId))));
}
