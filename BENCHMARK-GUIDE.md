# Controlled Search Benchmark

Use this benchmark to measure whether a search change improves accuracy instead of judging it from one successful or unsuccessful query.

## Build The Reference Set

1. Create 24 to 30 fixed test cases, balanced across US, UK and EU and across several product categories.
2. For every case, keep the same reference image, product name, description, material, dimensions and region.
3. Include easy, medium and difficult examples. Difficult cases should include visually similar but functionally different products.
4. Do not replace difficult cases after a poor result. A stable set is what makes version comparisons meaningful.

## Review Each Run

Record every returned row in `benchmark-template.csv`, up to six rows per test case. A human reviewer should mark:

- `relevant_pdp`: The page is a PDP for a genuinely similar physical product.
- `price_correct`: The displayed price matches the current sale price on that PDP.
- `region_correct`: The product and currency are appropriate for the selected market.
- `notes`: Brief reason for a rejection, such as wrong shape, pattern page, listing page or wrong material.

## Core Measures

- **Precision at 6:** Relevant PDP rows divided by all rows shown.
- **Six-result success rate:** Test cases that return six relevant PDPs divided by all test cases.
- **Price accuracy:** Correct extracted prices divided by accessible relevant PDPs.
- **Region accuracy:** Region-correct rows divided by all rows shown.
- **Coverage:** Test cases returning at least one valid PDP divided by all test cases.

Run the complete fixed set before and after a change. Promote a change only when the target measure improves without materially reducing price or region accuracy. Keep the benchmark images outside the public application and never place API keys in the CSV.
