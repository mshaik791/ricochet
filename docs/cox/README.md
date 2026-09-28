# Cox / VinSolutions reference docs
- VinSolutions_API_Overview.pdf — partner program overview, FAQ, event types, plans
- Step2_Service_Agreement.pdf — fee schedule and participation form (NOT signed yet)
- Step_1_2_Cox_Auto_API_Initial_Assessment.docx — blank initial assessment form

## OpenAPI specs (download from the storefront product pages, keep these exact filenames)
- lead-management.openapi.json         <- "Lead Management - 1.0" product page
- connect-event-solution.openapi.json  <- "Connect Event Solution - 1.0" product page

`npm run cox:spec-check` reads these and verifies every path in `src/adapters/vin/cox.ts` ENDPOINTS
exists in the spec. Run it after downloading and again whenever Cox bumps a version.
Specs are safe to commit (no credentials). Keys go in `.env` only.
