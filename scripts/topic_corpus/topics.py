"""The planted tasks of the synthetic corpus, and the words that fill them in.

Each planted task has a plain-English description (what a good group name should
say), several ways a user words the request, the tools an agent would call, and
how it answers. Two pairs are deliberately close neighbours (flights / hotels,
refunds / cancellations) so a fit has to tell near tasks apart.

Everything here is data; the randomness lives in generate.py and is seeded.
"""

from __future__ import annotations

from dataclasses import dataclass

CITIES = [
    "Lisbon",
    "Osaka",
    "Nairobi",
    "Denver",
    "Oslo",
    "Santiago",
    "Hanoi",
    "Montreal",
    "Cairo",
    "Perth",
    "Seville",
    "Tallinn",
    "Austin",
    "Kyoto",
    "Bogota",
    "Dublin",
    "Mumbai",
    "Zurich",
    "Reykjavik",
    "Lima",
    "Porto",
    "Seoul",
    "Vienna",
    "Accra",
    "Boston",
    "Taipei",
    "Prague",
]
DATES = [
    "next Friday",
    "March 14",
    "the first week of June",
    "this weekend",
    "October 3rd",
    "two weeks from Monday",
    "December 22",
    "the 9th of May",
    "late August",
    "tomorrow morning",
    "July 18",
    "the long weekend",
    "Sept 27",
    "the end of the month",
    "January 6",
]
NAMES = [
    "Priya Raman",
    "Tomas Weber",
    "Aiko Tanaka",
    "Marcus Bell",
    "Sofia Alvarez",
    "Liam O'Connor",
    "Fatima Khan",
    "Noah Fischer",
    "Elena Petrova",
    "Chidi Okafor",
    "Hannah Meyer",
    "Diego Rojas",
    "Yuki Mori",
    "Grace Nguyen",
    "Omar Haddad",
    "Ingrid Larsen",
    "Ben Carter",
    "Mei Lin",
]
AIRLINES = ["Northwind Air", "Bluebird Airways", "Meridian", "SkyLark", "Atlas Jet", "Cobalt Air"]
HOTELS = [
    "the Harbor Inn",
    "Grand Linden",
    "Cedar Suites",
    "the Ridgeway",
    "Lotus House",
    "Pinecrest Lodge",
]
PRODUCTS = [
    "a standing desk",
    "wireless earbuds",
    "a cast-iron skillet",
    "a 4K monitor",
    "running shoes",
    "an espresso grinder",
    "a yoga mat",
    "a mechanical keyboard",
    "a desk lamp",
    "a backpack",
    "a blender",
    "noise-cancelling headphones",
    "a camping tent",
    "a phone case",
]
ORDER_IDS = [
    f"#{n}" for n in (48213, 51907, 33841, 60275, 29118, 74402, 55630, 81094, 40386, 67721)
]
TABLES = [
    "orders",
    "subscriptions",
    "web_sessions",
    "invoices",
    "support_tickets",
    "signups",
    "shipments",
    "page_views",
    "payments",
    "inventory",
    "campaign_clicks",
    "refunds_log",
]
METRICS = [
    "monthly revenue",
    "weekly active users",
    "average order value",
    "churn rate",
    "conversion rate by channel",
    "median delivery time",
    "top ten customers by spend",
    "signups per region",
    "retention after 30 days",
    "tickets closed per agent",
]
REPOS = [
    "billing-service",
    "web-client",
    "ingest-api",
    "mobile-app",
    "auth-gateway",
    "search-indexer",
]
LANGS = ["Python", "TypeScript", "Go", "Rust", "Java", "Kotlin"]
PR_ISSUES = [
    "a possible race condition",
    "a missing null check",
    "an unbounded retry loop",
    "a SQL query built from user input",
    "a leaked file handle",
    "an off-by-one in pagination",
    "a swallowed exception",
    "a hard-coded timeout",
]
MEETINGS = [
    "the weekly product sync",
    "the Q3 planning call",
    "the incident review",
    "the design critique",
    "the board update",
    "the customer onboarding call",
    "the hiring committee debrief",
    "the sprint retrospective",
]
CONTRACTS = [
    "a software license agreement",
    "a commercial lease",
    "a master services agreement",
    "a supplier contract",
    "an NDA",
    "an employment agreement",
    "a distribution agreement",
]
CLAUSES = [
    "the termination clause",
    "payment terms",
    "the liability cap",
    "the renewal date",
    "the governing law",
    "confidentiality obligations",
    "the notice period",
    "indemnification",
]
REASONS = [
    "it arrived damaged",
    "it was the wrong size",
    "it stopped working after a week",
    "it never arrived",
    "I was charged twice",
    "it was not as described",
    "I changed my mind",
]
SLOTS = {
    "city": CITIES,
    "city2": CITIES,
    "date": DATES,
    "date2": DATES,
    "name": NAMES,
    "airline": AIRLINES,
    "hotel": HOTELS,
    "product": PRODUCTS,
    "order": ORDER_IDS,
    "table": TABLES,
    "metric": METRICS,
    "repo": REPOS,
    "lang": LANGS,
    "issue": PR_ISSUES,
    "meeting": MEETINGS,
    "contract": CONTRACTS,
    "clause": CLAUSES,
    "reason": REASONS,
}


@dataclass(frozen=True)
class Tool:
    name: str
    args: str
    result: str


@dataclass(frozen=True)
class PlantedTopic:
    id: str
    description: str
    requests: tuple[str, ...]
    tools: tuple[Tool, ...]
    answers: tuple[str, ...]


PLANTED: tuple[PlantedTopic, ...] = (
    PlantedTopic(
        id="flight_booking",
        description="Finding, booking or changing airline flights for a traveler",
        requests=(
            "Book me a flight from {city} to {city2} {date}, window seat if possible.",
            "I need to fly to {city2} on {date}. What are the cheapest nonstop options out of {city}?",
            "Please change the return flight for {name} from {date} to {date2}.",
            "Find a morning departure {city} -> {city2} on {airline} for {date} and book it for {name}.",
            "Can you check seat availability and fares to {city2} for two adults, leaving {date}?",
            "My flight to {city2} got cancelled. Rebook {name} on the next available departure.",
            "Compare {airline} and another carrier from {city} to {city2} {date}; book the better one.",
        ),
        tools=(
            Tool(
                "search_flights",
                '{{"from": "{city}", "to": "{city2}", "date": "{date}"}}',
                '{{"results": 5, "cheapest": "{airline} $312", "nonstop": true}}',
            ),
            Tool(
                "get_fare_rules", '{{"carrier": "{airline}"}}', '{{"changeable": true, "fee": 75}}'
            ),
            Tool(
                "book_flight",
                '{{"passenger": "{name}", "carrier": "{airline}"}}',
                '{{"status": "confirmed", "pnr": "K7QX2M"}}',
            ),
            Tool("select_seat", '{{"pnr": "K7QX2M", "seat": "14A"}}', '{{"status": "assigned"}}'),
        ),
        answers=(
            "Booked {airline} from {city} to {city2} for {name}; confirmation K7QX2M.",
            "I found nonstop options and reserved the cheapest one on {airline}. Confirmation K7QX2M.",
            "The flight is rebooked for {date2}; a $75 change fee applied.",
        ),
    ),
    PlantedTopic(
        id="hotel_booking",
        description="Finding and reserving hotel rooms or other lodging for a stay",
        requests=(
            "Reserve a room at {hotel} in {city} for {date}, three nights.",
            "I need a quiet hotel near the conference center in {city2} from {date}. Under $200 a night.",
            "Find lodging in {city} for {name} and a colleague, checking in {date}.",
            "Does {hotel} have a double room with breakfast on {date}? Book it if so.",
            "Extend {name}'s stay in {city2} by two nights starting {date}.",
            "Look for a pet-friendly place to stay in {city} {date}, and reserve the best-rated one.",
            "Cancel my room at {hotel} and book something closer to the airport in {city2}.",
        ),
        tools=(
            Tool(
                "search_hotels",
                '{{"city": "{city}", "check_in": "{date}"}}',
                '{{"results": 8, "best_rated": "{hotel}", "rate": 184}}',
            ),
            Tool(
                "get_room_options",
                '{{"hotel": "{hotel}"}}',
                '{{"rooms": ["double", "king", "suite"]}}',
            ),
            Tool(
                "reserve_room",
                '{{"hotel": "{hotel}", "guest": "{name}"}}',
                '{{"status": "confirmed", "reservation": "H-55812"}}',
            ),
        ),
        answers=(
            "Reserved a room at {hotel} in {city} starting {date}; reservation H-55812.",
            "I booked the best-rated option, {hotel}, at $184 a night with breakfast included.",
            "Your stay in {city2} is extended by two nights; reservation H-55812 updated.",
        ),
    ),
    PlantedTopic(
        id="refund_processing",
        description="Handling a customer's request to refund a purchase that has been delivered",
        requests=(
            "I'd like a refund for order {order}: {reason}.",
            "Customer {name} wants their money back for {product} ({order}); {reason}.",
            "Please process a refund on {order}. I already returned {product}.",
            "Refund {product} from order {order} to the original card, {reason}.",
            "{name} says {reason} and is asking for a full refund on {order}. Check the policy and decide.",
            "Was I charged twice for {order}? If so, please refund the duplicate payment.",
            "Issue a partial refund for {product}, order {order}; {reason}.",
        ),
        tools=(
            Tool(
                "lookup_order", '{{"order": "{order}"}}', '{{"status": "delivered", "total": 89.5}}'
            ),
            Tool(
                "check_refund_policy",
                '{{"order": "{order}"}}',
                '{{"eligible": true, "window_days": 30}}',
            ),
            Tool(
                "issue_refund",
                '{{"order": "{order}", "amount": 89.5}}',
                '{{"status": "refunded", "refund_id": "RF-3391"}}',
            ),
            Tool("send_customer_email", '{{"to": "{name}"}}', '{{"sent": true}}'),
        ),
        answers=(
            "Order {order} was within the refund window; $89.50 was refunded (RF-3391).",
            "I refunded {product} to the original payment method and emailed {name} a receipt.",
            "The refund for {order} is approved and will post in 3-5 business days.",
        ),
    ),
    PlantedTopic(
        id="order_cancellation",
        description="Cancelling or modifying an order before it ships",
        requests=(
            "Cancel order {order} please, it hasn't shipped yet.",
            "{name} ordered {product} by mistake ({order}). Stop it before it leaves the warehouse.",
            "Can you cancel {order}? I changed my mind about {product}.",
            "Change the delivery address on {order} instead of cancelling, if it hasn't shipped.",
            "Remove {product} from order {order} but keep the rest.",
            "Cancel everything pending for {name} and tell me what already shipped.",
            "Is {order} still cancellable? If it's packed, try to intercept it.",
        ),
        tools=(
            Tool(
                "lookup_order",
                '{{"order": "{order}"}}',
                '{{"status": "processing", "shipped": false}}',
            ),
            Tool("cancel_order", '{{"order": "{order}"}}', '{{"status": "cancelled"}}'),
            Tool("update_order", '{{"order": "{order}"}}', '{{"status": "updated"}}'),
            Tool("release_inventory", '{{"order": "{order}"}}', '{{"released": 1}}'),
        ),
        answers=(
            "Order {order} had not shipped, so I cancelled it and released the stock.",
            "Done: {product} was removed from {order}; the remaining items ship tomorrow.",
            "{order} was already packed, so I requested an intercept at the carrier instead.",
        ),
    ),
    PlantedTopic(
        id="sql_analytics",
        description="Answering business questions by writing and running SQL queries on a data warehouse",
        requests=(
            "What was {metric} last quarter? Query the {table} table.",
            "Write a SQL query for {metric} broken down by month using {table}.",
            "How does {metric} compare between this year and last? Use {table} and plot the trend.",
            "Pull {metric} from {table} and {table2}, joined on customer id.",
            "Our dashboard shows a dip in {metric}. Dig into {table} and tell me why.",
            "Give me {metric} for the last 90 days as a table.",
            "Which segment moved {metric} the most? Check {table}.",
        ),
        tools=(
            Tool(
                "describe_table",
                '{{"table": "{table}"}}',
                '{{"columns": ["id", "created_at", "amount", "region"]}}',
            ),
            Tool(
                "run_sql",
                '{{"query": "SELECT date_trunc(\'month\', created_at), sum(amount) FROM {table} GROUP BY 1"}}',
                '{{"rows": 12, "elapsed_ms": 420}}',
            ),
            Tool(
                "make_chart", '{{"kind": "line", "x": "month", "y": "value"}}', '{{"chart": "ok"}}'
            ),
        ),
        answers=(
            "{metric} rose 8% quarter over quarter; the query ran against {table} and returned 12 monthly rows.",
            "I joined the two tables and found most of the change came from one region; see the chart.",
            "Here is the query and its result: {metric} by month, with the largest drop in March.",
        ),
    ),
    PlantedTopic(
        id="code_review",
        description="Reviewing a pull request in a code repository and commenting on bugs and style",
        requests=(
            "Review PR #{pr} in {repo} and flag anything risky.",
            "Look through this {lang} diff for {issue} and leave comments.",
            "Can you do a code review of the latest changes to {repo}? Focus on {issue}.",
            "Is it safe to merge pull request #{pr}? Check tests and {issue}.",
            "Give feedback on the {lang} patch in {repo}; the author is {name}.",
            "Summarize what PR #{pr} changes and point out {issue} if any.",
            "Review the refactor in {repo} for correctness and naming.",
        ),
        tools=(
            Tool(
                "get_pull_request",
                '{{"repo": "{repo}", "number": {pr}}}',
                '{{"files_changed": 7, "additions": 213}}',
            ),
            Tool("read_file", '{{"path": "src/handler.{ext}"}}', '{{"lines": 188}}'),
            Tool("run_linter", '{{"repo": "{repo}"}}', '{{"warnings": 3}}'),
            Tool(
                "post_review_comment", '{{"repo": "{repo}", "number": {pr}}}', '{{"posted": true}}'
            ),
        ),
        answers=(
            "I left three comments on PR #{pr}: {issue} in the handler and two naming nits.",
            "The change looks correct overall, but {issue} should be fixed before merging.",
            "Tests pass; one blocking comment about {issue}, the rest are suggestions.",
        ),
    ),
    PlantedTopic(
        id="meeting_summary",
        description="Summarizing a meeting transcript into key points, decisions and action items",
        requests=(
            "Summarize the transcript of {meeting} and list action items.",
            "Here are the notes from {meeting}. Give me the decisions and who owns what.",
            "Turn {meeting} into a short recap for people who missed it, led by {name}.",
            "What did we decide in {meeting}? Pull out deadlines and owners.",
            "Write follow-up email bullets from {meeting}.",
            "Condense an hour of {meeting} into five bullet points.",
            "Extract open questions and next steps from {meeting}.",
        ),
        tools=(
            Tool(
                "fetch_transcript", '{{"meeting": "{meeting}"}}', '{{"minutes": 54, "speakers": 5}}'
            ),
            Tool(
                "identify_speakers",
                '{{"meeting": "{meeting}"}}',
                '{{"speakers": ["{name}", "A. Reed", "J. Park"]}}',
            ),
            Tool("save_summary", '{{"meeting": "{meeting}"}}', '{{"saved": true}}'),
        ),
        answers=(
            "Summary of {meeting}: three decisions, four action items; {name} owns the follow-up.",
            "Key points: scope was reduced, the launch date held, and two questions remain open.",
            "Action items: {name} drafts the plan by Friday; the rest are in the list above.",
        ),
    ),
    PlantedTopic(
        id="contract_extraction",
        description="Extracting specific clauses and fields from legal contracts",
        requests=(
            "Extract {clause} from {contract} and quote it.",
            "Read {contract} and tell me the parties, effective date and {clause}.",
            "Does {contract} with {name} limit liability? Find {clause}.",
            "List every obligation about {clause} in the attached {contract}.",
            "Pull the key dates and {clause} from {contract} into a table.",
            "Compare {clause} in these two versions of {contract} and flag differences.",
            "Find anything unusual in {clause} of {contract}.",
        ),
        tools=(
            Tool("load_document", '{{"type": "{contract}"}}', '{{"pages": 23}}'),
            Tool("find_clause", '{{"clause": "{clause}"}}', '{{"section": "9.2", "found": true}}'),
            Tool(
                "extract_fields", '{{"fields": ["parties", "effective_date"]}}', '{{"parties": 2}}'
            ),
        ),
        answers=(
            "{clause} appears in section 9.2: the text is quoted above, with the page reference.",
            "The agreement names two parties, takes effect at signing, and {clause} is standard.",
            "I extracted the requested fields and flagged one non-standard term in {clause}.",
        ),
    ),
)

# Requests that belong to no planted task: one-off questions with nothing in common.
NOISE_REQUESTS = (
    "Write a haiku about a lighthouse in winter.",
    "What is the capital of Burkina Faso?",
    "Translate 'where is the train station' into Finnish.",
    "Explain the birthday paradox simply.",
    "Give me a workout plan for someone with a bad knee.",
    "What rhymes with 'orange'?",
    "How do bees decide where to build a hive?",
    "Tell me a joke about compilers.",
    "Convert 72 fahrenheit to celsius and kelvin.",
    "Why is the sky dark at night if there are infinite stars?",
    "Suggest names for a cat that looks like a loaf of bread.",
    "How long should I boil an egg for a runny yolk?",
    "Draft a polite note declining a wedding invitation.",
    "What was the main cause of the Dust Bowl?",
    "Teach me three chess openings for beginners.",
    "What is the difference between affect and effect?",
    "Recommend a houseplant that survives neglect.",
    "How do vaccines train the immune system?",
    "Plan a 20 minute meditation script.",
    "Who painted the ceiling of the Sistine Chapel?",
    "Is a tomato a fruit or a vegetable? Settle a debate.",
    "Explain how a transistor works to a ten year old.",
    "Compose a limerick about a forgetful wizard.",
    "How many moons does Jupiter have?",
    "Give me a mnemonic for the planets in order.",
    "What should I name my sourdough starter?",
    "Describe the plot of Hamlet in two sentences.",
    "Suggest a color palette for a bakery logo.",
    "How do I get red wine out of a carpet?",
    "What is the speed of sound in water?",
    "Write a toast for my sister's graduation.",
    "Explain what an index fund is.",
    "Why do cats purr?",
    "List five facts about the Roman aqueducts.",
    "How do I say thank you in Swahili, Thai and Welsh?",
    "What's a good stretch for tight hips?",
    "Rewrite this sentence to sound friendlier: 'Send the file now.'",
    "Why are flamingos pink?",
    "Give a quick history of the bicycle.",
    "What are the rules of cricket in one paragraph?",
)

NOISE_ANSWERS = (
    "Here is a short answer to your question.",
    "Sure, here you go.",
    "I hope that helps; let me know if you want more detail.",
)
