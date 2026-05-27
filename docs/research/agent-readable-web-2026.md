# The Agent-Readable Web: State of the Art (May 2026)
Research report on standards, conventions, and infrastructure that expose web data in structured formats for AI agents.

* * *
## 1. llms.txt — The robots.txt for LLMs
**Spec**: Proposed by Jeremy Howard (Answer.AI/FastAI) on September 3, 2024. A Markdown file at `/llms.txt` with a curated list of links to a site's highest-value content plus a one-paragraph brand summary. Companion file `/llms-full.txt` includes full inline content (Vercel's is ~400k words).

**Adoption**: ~10% of top 300k domains (SERanking, Nov 2025). BuiltWith tracked 844k+ implementations by Oct 2025. Notable adopters: Anthropic, Stripe, Cursor, Cloudflare, Vercel, Mintlify, Supabase, ElevenLabs. A directory at llms-text.com lists 784+ live examples. Walmart briefly had one (Nov 2025, removed by Jan 2026).

**Reality check**: Major LLM crawlers (GPTBot, GoogleExtended, ClaudeBot) are **not** fetching it in meaningful volume. An XGBoost model for AI citation prediction _improved_ when the llms.txt variable was removed. 8/9 sites saw no measurable traffic change after implementation. Google's Gary Illyes confirmed Google doesn't support it; John Mueller compared it to the discredited keywords meta tag.

**Where it works**: IDE agents (Cursor, Windsurf, Claude Code, GitHub Copilot, Cline, Aider) **do** fetch `/llms.txt` routinely. LangChain's `mcpdoc` MCP server exposes llms.txt files to host apps. It's a **developer-experience play**, not an SEO play — the first standardized B2A (Business-to-Agent) surface.

**Verdict**: Low cost (~half day), no proven SEO benefit, real value for developer tooling. Not dead, but not the standard it's being sold as. Google included it in their A2A protocol docs, signaling experimental interest.

* * *
## 2. MCP (Model Context Protocol) — The USB-C of AI
**Origin**: Open-sourced by Anthropic November 2024. Standardizes how agents connect to external tools, databases, and APIs. Uses Streamable HTTP transport (formerly SSE).

**Adoption — beyond Anthropic**:

| Platform | Status |
| --- | --- |
| OpenAI | ChatGPT + API support (March 2025) |
| Google | Gemini API + Vertex AI Agent Builder (Q1 2026) |
| Microsoft | MCP servers for GitHub, Azure, Teams, M365 |
| IDE ecosystem | VS Code, Cursor, Windsurf, Cline — native |
| Agent frameworks | 92% of new frameworks ship MCP support (LangGraph, CrewAI, AutoGen) |

**Scale**: 97M+ monthly SDK downloads, 10k+ active servers in production, 9,400+ public servers by April 2026. 78% enterprise team adoption.

**Governance**: Donated to **Linux Foundation's Agentic AI Foundation (AAIF)** in December 2025, co-founded by Anthropic, Block, OpenAI, with AWS, Google, Microsoft as members.

**Security**: June 2025 update mandated PKCE (OAuth 2.1), Resource Indicators (RFC 8707), and explicitly prohibited token passthrough. Anonymous Dynamic Client Registration remains a concern for enterprises.

**2026 Roadmap**: Stateless Streamable HTTP across server instances, enterprise auth with SSO, gateway/proxy patterns, triggers and event-driven updates.

**Verdict**: MCP crossed from "Anthropic-led" to "industry-default" between July 2025 and February 2026. It is the de facto standard for agent-to-tool communication. The protocol closest to "won."

* * *
## 3. A2A (Agent-to-Agent Protocol) — Google's Answer
**What**: Google-introduced (April 2025) protocol for multi-agent systems. Uses HTTP + SSE + JSON-RPC 2.0. Agents advertise capabilities via **Agent Cards**.

**Scope**: Where MCP connects agents to tools, A2A connects agents to agents. Complementary, not competing.

**Adoption**: 150+ organizations by April 2026 (Google, Microsoft, AWS, Salesforce, SAP, ServiceNow, Workday, IBM). Donated to Linux Foundation June 2025. v0.3 added gRPC support and signed security cards. **v1.0 announced at Google Cloud Next 2026**.

**Architecture**: Agent Cards (capability discovery) + Tasks (work units) + HTTP/SSE/JSON-RPC transport. Azure AI Foundry, Amazon Bedrock AgentCore, and Google Cloud all integrated natively.

* * *
## 4. Other Emerging Protocols
| Protocol | Origin | Transport | Purpose |
| --- | --- | --- | --- |
| **ACP** (Agent Communication Protocol) | IBM | REST/HTTP | Enterprise MIME-typed multipart messages, RBAC + DID auth |
| **AGP** (Agent Gateway Protocol) | Community | gRPC/HTTP2 + Protobuf | High-throughput messaging between distributed agents |
| **ANP** (Agent Network Protocol) | Community | Decentralized | Open agent marketplaces |
| **WebMCP** | Google I/O 2026 | Web-native | Default contract for agent-facing web products |
| **VOIX** | TU Darmstadt | HTML `<tool>` + `<context>` tags | Declarative agent-web interaction directly in HTML |

**W3C AI Agent Protocol Community Group** is working toward official web standards for agent communication, with specifications expected 2026-2027.

**NIST** released a concept paper on "Accelerating the Adoption of Software and AI Agent Identity and Authorization" (public comments closed April 2, 2026) — first federal-level effort on agent identity governance.

* * *
## 5. JSON Feed
**Spec**: JSON-based web syndication format (v1.1), alternative to RSS/Atom. Created 2017 by Manton Reece and Brent Simmons. MIME type: `application/feed+json`.

**Adoption**: Supported by NetNewsWire, NewsBlur, ReadKit, Reeder, Micro.blog, NPR. Lower adoption than RSS/Atom since CMS platforms have no incentive to switch.

**AI relevance**: Easier to parse than XML-based feeds. `feed-mcp` is an open-source MCP server that exposes RSS/Atom/JSON feeds to AI agents. Structured content updates improve freshness signals for AI training data.

**Verdict**: Niche but useful. If you're building new infrastructure, JSON Feed is simpler than RSS. But RSS remains the pragmatic default.

* * *
## 6. Structured Data: JSON-LD + Schema.org
**Adoption**: ~47.6% of top 10M websites include at least one JSON-LD block (Common Crawl, July 2025). Google recommends JSON-LD as the preferred schema format.

**AI impact**: Pages with valid structured data are **2.3x more likely** to appear in Google AI Overviews (Semrush 2025). Princeton GEO research found up to **40% higher visibility** in AI-generated responses for content with clear structural signals.

**Who consumes it**: ChatGPT, Perplexity, Google AI Overviews, and AI agents all parse JSON-LD when browsing pages. It provides high-confidence facts that LLMs cite directly.

**Caveat**: Some agents strip `<script>` blocks to reduce context load during live queries, so the relationship is still evolving.

**Verdict**: JSON-LD is the most impactful existing standard for AI visibility. Unlike llms.txt, it has proven measurable effects. If you do one thing, do this.

* * *
## 7. Web-to-Markdown Infrastructure (The Scraping Layer)
The web wasn't built for agents. These tools bridge the gap:

| Tool | Model | What it does | Scale |
| --- | --- | --- | --- |
| **Firecrawl** (YC) | SaaS + OSS (AGPL-3.0) | URL -> clean Markdown/JSON. Full-site crawling, JS rendering, AI extraction | 350k+ devs, 50k GH stars, $16.2M raised |
| **Jina Reader** | API (Apache-2.0) | Prepend `r.jina.ai/` to any URL -> Markdown | Free tier, token-based billing |
| **Apify** | SaaS + OSS | Actor-based web scraping platform | Mature, enterprise |
| **Kernel** (YC S25) | OSS | Unikernel-based headful browsers, sub-150ms cold starts, stealth mode | Early stage, Accel-backed |

**Cloudflare's approach**: Documentation pages now serve Markdown via `Accept: text/markdown` header or `index.md` suffix. Per-product `llms.txt` files. "If you are an AI agent, always request the Markdown version — HTML wastes context."

* * *
## 8. Agent Authentication — The Hardest Unsolved Problem
**Current state**: A mess. An agent authenticates to an LLM provider via API key, an enterprise API via OAuth, a cloud database via managed identity, and a tool server via MCP token — all in the same task. No unified layer.

**Key stats**:

- 28.65M hardcoded secrets added to public GitHub in 2025 (+34% YoY)
  
- Secret leak rates in AI-assisted code run **2x** the GitHub-wide baseline
  
- Machine identities outnumber human identities **82:1**
  
- Only **23%** of organizations have a formal strategy for agent identity management
  

**MCP auth**: Mandates OAuth 2.1 with PKCE, but anonymous Dynamic Client Registration means any client can register without identifying itself. Not enterprise-ready.

**Emerging solutions**:

| Approach | Status |
| --- | --- |
| **DPoP** (Sender-Constrained Tokens) | Binds tokens to agent's crypto key. Intercepted tokens are useless. |
| **Persistent Agent IDs** | Stable identity decoupled from runtime. Early-stage. |
| **Verifiable Credentials (Agent-VCs)** | Signed, third-party-issued attestations bound to Agent ID. |
| **Zero Standing Privileges (ZSP)** | RFC 8693 token exchange for per-task, downscoped tokens. |
| **Auth0 Token Vault** | Short-lived, narrowly-scoped credentials. Agents never hold raw API keys. |
| **Cloudflare Web Bot Auth** | IETF Working Group established. Open registry format for agent public keys + Signature Agent Cards. |

**Platforms**:

| Platform | Funding | Approach |
| --- | --- | --- |
| **Composio** (YC) | $29M Series A | Managed auth + 250+ pre-built tool connectors |
| **Nango** | OSS | OAuth/credential management for 800+ APIs |
| **Arcade** | $12M seed | "SSO for AI agents" — just-in-time permissions |
| **Allowance** (YC) | Early | Scoped one-time payment credentials for agent purchases |

**Verdict**: Authentication/authorization is the #1 unsolved infrastructure problem. The gap between "agent has valid credentials" and "agent should be allowed to do this specific thing" is where the real risk and opportunity lie.

* * *
## 9. Cloudflare's Agent Infrastructure Play
Cloudflare is positioning as the full-stack agent deployment platform:

- **Agents SDK**: Persistent, stateful execution on Durable Objects. Hibernate when idle, wake on demand. Pay only for compute, not wall time.
  
- **Docs for Agents**: All docs serve Markdown via `Accept: text/markdown`. Per-product llms.txt. Explicit agent instructions in HTML.
  
- **Web Bot Auth**: IETF Working Group (WebBotAuth WG). Open registry format with Amazon Bedrock AgentCore. Signature Agent Cards (JSON with agent name, operator, rate limits, crypto keys).
  
- **MCP support**: Built-in MCP server hosting, OAuth authorization for MCP.
  
- **A2A support**: Example in agents SDK repo.
  
- **Browser tools**: Chrome DevTools Protocol integration for agents to scrape, screenshot, and interact.
  
- **Scale**: AI bot requests exceed **10B/week** on Cloudflare's network. CEO Matthew Prince predicts bot traffic will exceed human traffic by 2027.
  

* * *
## 10. YC-Backed Startups & Key Projects
| Company | YC Batch | What | Traction |
| --- | --- | --- | --- |
| **Firecrawl** | Yes | Web -> LLM-ready Markdown/JSON | 350k devs, $16.2M raised, profitable |
| **Mastra** | W25 | TypeScript AI agent framework (from Gatsby team) | 22k+ GH stars, 300k weekly npm downloads, $13M |
| **Kernel** | S25 | Unikernel browsers for agent web access | Accel-backed |
| **Armature** | Yes | AX (Agent Experience) analytics + MCP testing | Early |
| **Wildcard** | Yes | AEO/GEO platform for e-commerce AI visibility | Early |
| **AgentPhone** | Yes | Phone numbers for AI agents (identity layer) | Early |
| **Allowance** | Yes | Scoped payment credentials for agent purchases | Early |
| **Composio** | Yes | Agent auth + tool integration (250+ connectors) | $29M Series A |

**Research projects**:

- **Project NANDA** (MIT): "DNS for agents" — decentralized registry, discovery, attestation
  
- **BetaWeb**: Blockchain-enabled trustworthy agentic web ("Web 3.5")
  
- **VOIX** (TU Darmstadt): Declarative `<tool>` and `<context>` HTML tags for agent interaction
  

* * *
## What Exists Today (Summary)
| Layer | Standard/Tool | Maturity |
| --- | --- | --- |
| Agent-to-tool | **MCP** | Won. Industry standard. Linux Foundation. |
| Agent-to-agent | **A2A** | v1.0. 150+ orgs. Linux Foundation. |
| Site discovery | **llms.txt** | ~10% adoption. IDE agents use it. LLMs don't. |
| Structured data | **JSON-LD / Schema.org** | 47.6% of top sites. Proven AI visibility impact. |
| Web scraping | **Firecrawl / Jina** | Mature. Essential plumbing. |
| Content feeds | **JSON Feed / RSS** | RSS dominant. JSON Feed niche but growing. |
| Agent auth | **OAuth 2.1 (via MCP)** | Minimum viable. Enterprise gaps remain. |
| Agent identity | **Web Bot Auth (IETF)** | Working group established. Pre-standard. |
| Agent runtime | **Cloudflare Agents SDK** | Production. Leading edge platform. |
| Agent frameworks | **Mastra, LangGraph, CrewAI** | Mature. 92% ship MCP support. |

* * *
## What's Missing (The Gaps)
1. **Unified agent identity**: No equivalent of SSL certificates for agents. Persistent Agent IDs, Verifiable Credentials, and Web Bot Auth are all pre-standard. Agents can't prove who they are across services.
  
2. **Authorization beyond authentication**: OAuth tells you who the agent is, not what it should be allowed to do _in this specific context_. Per-action authorization at scale doesn't exist.
  
3. **Agent-native web markup**: VOIX's `<tool>` and `<context>` tags are a research prototype. WebMCP was just announced at Google I/O 2026. There's no deployed standard for websites to declare "here's what agents can do here" in-page.
  
4. **Payment rails for agents**: Allowance is early-stage. Agents can't easily pay for services, subscribe to APIs, or handle metered billing autonomously.
  
5. **Discovery/registry**: No production "DNS for agents." Project NANDA is research-stage. Agents can't discover other agents or services without hardcoded endpoints.
  
6. **Consent and permissions**: robots.txt is from 1994 and is being ignored (OpenAI removed compliance language in 2026). No replacement consent framework exists. A Duke study found many AI crawlers never request robots.txt at all.
  
7. **Observability**: No standard for tracing an agent's actions across multiple services. Audit trails are service-specific.
  
8. **Content freshness signals**: No standard way for an agent to know "this content changed since you last saw it" without re-fetching everything.
  

* * *
## Where the Opportunity Is
### Highest-conviction bets (infrastructure that's clearly needed):
1. **Agent auth middleware**: The Stripe of agent authentication. Composio and Nango are early. The market is $85B+ and growing 32% CAGR. Whoever solves "agent OAuth + per-action authorization + audit trail" in one product wins a massive market.
  
2. **Agent-readable content layer**: A service that sits between existing websites and agents, serving structured content with freshness signals, consent metadata, and usage metering. Think: CDN-level agent content negotiation. Cloudflare is building pieces of this but hasn't unified them.
  
3. **Agent registry / discovery**: The DNS of the agentic web. NANDA is research. Someone needs to ship a production-grade, decentralized agent directory with capability attestation.
  
4. **Agent-native web standard**: The successor to both llms.txt and robots.txt. A single file or in-page markup that declares: what agents can do, what content is available, consent terms, and rate limits. Google's WebMCP and VOIX are early attempts. The W3C community group is working on it. First-mover advantage is available.
  
5. **Agent payment/billing infrastructure**: Metered API billing, agent wallets, micro-transactions between agents. The plumbing for an agent economy.
  
### The meta-opportunity:
The web is being rebuilt for a second audience. The first web was built for humans reading HTML. The agent-readable web needs structured content, machine identity, consent frameworks, and payment rails. We're in the "dial-up phase" (Forrester's words). Every layer of the stack — from DNS to auth to content format to billing — needs an agent-native equivalent. The companies building that infrastructure in 2026 will be the Cloudflares and Stripes of 2030.

* * *
## Sources
- [State of llms.txt 2026 — Presenc AI](https://presenc.ai/research/state-of-llms-txt-2026)
  
- [Is llms.txt Dead? — llms-txt.io](https://llms-txt.io/blog/is-llms-txt-dead)
  
- [llms.txt Explained (May 2026) — Codersera](https://codersera.com/blog/llms-txt-complete-guide-2026/)
  
- [LLMs.txt: Why Brands Rely On It and Why It Doesn't Work — SERanking](https://seranking.com/blog/llms-txt/)
  
- [Who is Using llms.txt? — llms-text.com](https://www.llms-text.com/blog/sites-using-llms-txt)
  
- [MCP Adoption Statistics 2026 — Digital Applied](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol)
  
- [A Year of MCP — Pento](https://www.pento.ai/blog/a-year-of-mcp-2025-review)
  
- [MCP Impact on 2025 — Thoughtworks](https://www.thoughtworks.com/en-us/insights/blog/generative-ai/model-context-protocol-mcp-impact-2025)
  
- [2026 MCP Roadmap — modelcontextprotocol.io](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
  
- [MCP Enterprise Adoption Guide — Deepak Gupta](https://guptadeepak.com/the-complete-guide-to-model-context-protocol-mcp-enterprise-adoption-market-trends-and-implementation-strategies/)
  
- [AI Agent Protocols 2026 — Ruh AI](https://www.ruh.ai/blogs/ai-agent-protocols-2026-complete-guide)
  
- [Agent-to-Agent Protocols Survey — arXiv](https://arxiv.org/pdf/2505.02279)
  
- [What Is Agent2Agent Protocol? — IBM](https://www.ibm.com/think/topics/agent2agent-protocol)
  
- [A2A Getting an Upgrade — Google Cloud Blog](https://cloud.google.com/blog/products/ai-machine-learning/agent2agent-protocol-is-getting-an-upgrade)
  
- [AI Agent Authentication Guide — Nango](https://nango.dev/blog/guide-to-secure-ai-agent-api-authentication/)
  
- [AI Agents Authentication — GitGuardian](https://blog.gitguardian.com/ai-agents-authentication-how-autonomous-systems-prove-identity/)
  
- [OAuth for AI Agents — ScaleKit](https://www.scalekit.com/blog/oauth-ai-agents-architecture)
  
- [AI Agent Identity Multi-Protocol Gap — Aembit](https://aembit.io/blog/ai-agent-identity-security/)
  
- [Common Risks of API Keys for AI Agents — Auth0](https://auth0.com/blog/api-key-security-for-ai-agents/)
  
- [Cloudflare Docs for Agents](https://developers.cloudflare.com/docs-for-agents/)
  
- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
  
- [Cloudflare Web Bot Auth — Stellagent](https://stellagent.ai/insights/cloudflare-web-bot-auth-agent-verification)
  
- [AI Agent Authentication Platforms — Composio](https://composio.dev/blog/ai-agent-authentication-platforms)
  
- [Nango vs Composio — Nango](https://nango.dev/blog/composio-alternatives/)
  
- [Firecrawl vs Jina Reader 2026 — Use Apify](https://use-apify.com/blog/firecrawl-vs-jina-reader-2026)
  
- [Best Web Scraping Tools for AI Agents — Fastio](https://fast.io/resources/best-web-scraping-tools-ai-agents/)
  
- [JSON-LD Masterclass for AI Agents — Jasmine Directory](https://www.jasminedirectory.com/blog/json-ld-masterclass-implementing-schema-for-ai-agents/)
  
- [Structured Data in AI Search Era — BrightEdge](https://www.brightedge.com/blog/structured-data-ai-search-era)
  
- [JSON Feed Spec — jsonfeed.org](https://www.jsonfeed.org/)
  
- [feed-mcp for AI Agents — Richard Wooding](https://medium.com/@richardwooding/supercharging-ai-agents-with-rss-atom-json-feeds-a-developers-guide-to-feed-mcp-7da545669f96)
  
- [The Agentic Web — The New Stack](https://thenewstack.io/the-agentic-web-how-ai-agents-are-shaping-the-webs-future/)
  
- [What is the Agentic Web? — Richard MacManus](https://ricmac.org/2026/05/08/what-is-the-agentic-web/)
  
- [Building the Web for Agents (VOIX) — arXiv](https://arxiv.org/pdf/2511.11287)
  
- [Project NANDA — MIT Media Lab](https://www.media.mit.edu/projects/mit-nanda/overview/)
  
- [Mastra — Y Combinator](https://www.ycombinator.com/companies/mastra)
  
- [5 Under-the-Radar AI Infrastructure Companies — TechPluto](https://www.techpluto.com/ai-infrastructure-companies-2026/)
  
- [WebMCP from Google I/O 2026 — DEV Community](https://dev.to/soumyadeepdey/why-webmcp-is-the-most-important-thing-google-announced-at-io-2026-and-nobodys-talking-about-it-2edf)
  
- [Google Cloud Next 2026 — The Next Web](https://thenextweb.com/news/google-cloud-next-ai-agents-agentic-era)
