import type { SiteCoderFileBundle } from "../../src/cli/runtime/site-coder-file-bundle.js";

// Exact retained failure pattern: Header's Search had no search state or results.
export const reportedAlertSearch = Array<string>(33).fill("").join("\n") + '\n<button type="button" aria-label="Search" onClick={() => window.alert("Search is available in this demo store.")}>Search</button>';
export const ecommercePrompt = "Build a premium clothing store for North & Loom. Home page and product-detail experience: hero promotion, categories, featured products, product cards, sale badges, selectable product gallery with thumbnails, product sizes, quantity controls, Add to Cart, cart view, category filtering, search, newsletter signup, footer and responsive navigation. Use frontend mock data only.";
export const corporatePrompt = "Build a corporate single-page website for Cedar Works with mobile navigation, contact form, tabs, accordion, modal dialog and a working enquiry button. Use frontend mock data only.";
export const portfolioPrompt = "Build a portfolio landing website for Mira Studio with mobile menu, tabs, accordion and newsletter signup. Use frontend mock data only.";
const css = `:root{color:#25372d;background:#f6f0e5;font-family:Arial,sans-serif}*{box-sizing:border-box}body{margin:0}h1,h2,h3{font-family:Georgia,serif}header,main,footer{padding:22px 5vw}header{display:flex;flex-wrap:wrap;align-items:center;gap:20px;border-bottom:1px solid}a{color:inherit}nav{display:flex;flex-wrap:wrap;gap:20px}button,input,select,textarea{font:inherit;padding:8px;max-width:100%}button{cursor:pointer}label{display:block;margin:8px 0}section{margin:18px 0}img{max-width:100%;height:auto}.hero,.products,.product-page{display:grid;grid-template-columns:1fr 1fr;gap:20px}.card{padding:18px;border:1px solid}.sale{color:#a94e35}[data-sites-capability=gallery]>img{width:240px}[data-sites-capability=gallery] button img{width:60px}[hidden]{display:none!important}aside{padding:18px;border:2px solid}footer{border-top:1px solid}@media(max-width:700px){.hero,.products,.product-page{grid-template-columns:1fr}}`;
const ecommerce = `import { useState } from "react";
import { useCart, CartPanel, AddToCartButton, useQuantity, QuantityControl, SizeSelector, ProductGallery, useProductFilter, CategoryFilter, ProductSearch, NewsletterSignup } from "./sites-ui/functional";
import "./styles.css";
const products=[{id:"linen",name:"Linen Shirt",category:"Shirts",price:80,image:"/front.svg"},{id:"knit",name:"Everyday Knit",category:"Knitwear",price:120,image:"/back.svg"}];
export function App(){
 const cart=useCart(); const quantity=useQuantity(); const [size,setSize]=useState("M"); const filter=useProductFilter(products);
 const product=products.find(item=>item.id===new URLSearchParams(location.search).get("id"))||products[0];
 const detail=location.pathname==="/product";
 return <><header><a href="/">North &amp; Loom</a><nav><a href="/">Home</a><a href="/product?id=linen">Product detail</a></nav>
 <button data-sites-action="cart.open" type="button" aria-expanded={cart.isOpen} aria-controls="sites-demo-cart" onClick={()=>{}}>Cart ({cart.count})</button></header><CartPanel/>
 <main>{detail?<section className="product-page"><ProductGallery images={[{src:"/front.svg",alt:"Linen shirt front"},{src:"/back.svg",alt:"Linen shirt back"}]}/><div><h1>North &amp; Loom {product.name}</h1><p>Premium natural layers for every day.</p><SizeSelector options={["S","M","L"]} value={size} onChange={setSize}/><QuantityControl value={quantity.quantity} onChange={quantity.setQuantity}/><AddToCartButton product={product} quantity={quantity.quantity} size={size}/></div></section>:<>
 <section className="hero"><div><h1>North &amp; Loom</h1><p>Considered clothing for a slower wardrobe.</p><a href="/product?id=linen">Shop the collection</a><button type="button" onClick={()=>{location.href="/product?id=linen"}}>Browse product</button></div><img src="/front.svg" alt="Clothing promotion"/></section>
 <section><h2>Shop by category</h2><CategoryFilter options={filter.categories} value={filter.category} onChange={filter.setCategory}/><h2>Featured products</h2><div className="products">{filter.visible.map(item=><article className="card" data-product-id={item.id} key={item.id}><h3>{item.name}</h3><span className="sale">Sale — 20% off</span><p>{item.category}</p><a href={"/product?id="+item.id}>View {item.name}</a></article>)}</div></section><ProductSearch products={products}/></>}</main>
 <footer><h2>North &amp; Loom newsletter</h2><NewsletterSignup/><p>Frontend demonstration store.</p></footer></>;
}`;
const corporate = `import { useState } from "react";
import { MobileNav,Tabs,Accordion,DemoDialog } from "./sites-ui/functional";
import { Button } from "./sites-ui/primitives/Button";
import { ContactSection } from "./sites-ui/sections/ContactSection";
import "./styles.css";
export function App(){const [enquiries,setEnquiries]=useState(0);return <><header><a href="/">Cedar Works</a><MobileNav items={[{label:"Overview",href:"#overview"},{label:"Contact",href:"#contact"}]}/></header><main><section id="overview"><h1>Cedar Works</h1><p>Practical strategy for growing businesses.</p><Button onClick={()=>setEnquiries(value=>value+1)}>Request information</Button><p role="status">Demo enquiries in this view: {enquiries}</p></section><Tabs items={[{id:"strategy",label:"Strategy",content:<p>Strategy workshops and planning.</p>},{id:"delivery",label:"Delivery",content:<p>Hands-on delivery and measurement.</p>}]}/><Accordion items={[{id:"process",label:"Our process",content:<p>Discover, plan and deliver together.</p>}]}/><DemoDialog label="Read company note"><p>Local company information, not an external action.</p></DemoDialog><section id="contact"><ContactSection/></section></main><footer>Cedar Works · Frontend demo</footer></>}`;
const portfolio = `import { MobileNav,Tabs,Accordion,NewsletterSignup } from "./sites-ui/functional";
import "./styles.css";
export function App(){return <><header><a href="/">Mira Studio</a><MobileNav items={[{label:"Work",href:"#work"},{label:"Newsletter",href:"#newsletter"}]}/></header><main><section id="work"><h1>Mira Studio</h1><p>Independent design and careful craft.</p><Tabs items={[{id:"identity",label:"Identity",content:<p>Editorial identities and thoughtful typography.</p>},{id:"digital",label:"Digital",content:<p>Accessible digital experiences.</p>}]}/><Accordion items={[{id:"approach",label:"Working together",content:<p>Collaborative exploration and iterative delivery.</p>}]}/></section><section id="newsletter"><h2>Studio notes</h2><NewsletterSignup/></section></main><footer>Mira Studio · Frontend demo</footer></>}`;
const image = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="${color}"/><path d="M100 40h100v130H100z" fill="#f6f0e5"/></svg>`;
export const functionalFixtures: Record<"ecommerce" | "corporate" | "portfolio", SiteCoderFileBundle> = {
  ecommerce: { siteName: "North & Loom", files: [{path:"src/App.tsx",content:ecommerce},{path:"src/styles.css",content:css},{path:"public/front.svg",content:image("#36513e")},{path:"public/back.svg",content:image("#b46a4d")}] },
  corporate: { siteName:"Cedar Works",files:[{path:"src/App.tsx",content:corporate},{path:"src/styles.css",content:css}] },
  portfolio: { siteName:"Mira Studio",files:[{path:"src/App.tsx",content:portfolio},{path:"src/styles.css",content:css}] },
};
