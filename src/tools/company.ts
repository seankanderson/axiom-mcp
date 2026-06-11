import { z } from 'zod'
import { axiomApi } from '../apiClient.js'


// ── Company profile tools ────────────────────────────────────────────────────
// Role notes (see role-permissions-matrix.md):
//   view:   all roles
//   edit:   admin + supervisor only (enforced by the API)

export const getCompanyProfile = {
    name: 'get_company_profile',
    description:
        'Get the full company profile for the bound company, including its name, display name, address, contact info, fiscal year settings, invoice settings, and the caller\'s role. Use this first to discover the company name — the user only holds a company id.',
    inputSchema: z.object({}),
    handler: async (_raw: unknown) => {
        const companyId = axiomApi.getCompanyId()
        return await axiomApi.get(`/companies/${companyId}`)
    },
}

const ContactInfoInput = z.object({
    phoneNumber: z.string().optional(),
    email:       z.string().email().optional(),
    website:     z.string().optional(),
})

const AddressInput = z.object({
    line1:    z.string().optional(),
    line2:    z.string().optional(),
    city:     z.string().optional(),
    province: z.string().optional(),
    postcode: z.string().optional(),
    country:  z.string().optional(),
})

const FiscalYearInput = z.object({
    startMonth: z.number().int().min(1).max(12).optional().describe('Month the fiscal year starts (1=Jan).'),
    startYear:  z.number().int().optional().describe('Calendar year the current fiscal year begins.'),
})

const UpdateCompanyProfileInput = z.object({
    name:        z.string().min(1).describe('Legal company name (required by the API).'),
    displayName: z.string().optional().describe('Friendly display name shown in the UI. Defaults to name if omitted.'),
    legalName:   z.string().optional(),
    entityType:  z.string().optional().describe('e.g. LLC, S-Corp, Partnership.'),
    industry:    z.string().optional(),
    tin:         z.string().optional().describe('Federal Tax ID (EIN).'),
    contact:     ContactInfoInput.optional(),
    address:     AddressInput.optional(),
    fiscalYear:  FiscalYearInput.optional(),
    notes:       z.string().optional(),
})

export const updateCompanyProfile = {
    name: 'update_company_profile',
    description:
        'Update the company profile. Only admins and supervisors may call this — bookkeepers and clerks will receive a 403 (enforced server-side). Provide all fields you want to set; omitted optional fields are preserved from the current profile.',
    inputSchema: UpdateCompanyProfileInput,
    handler: async (raw: unknown) => {
        const input = UpdateCompanyProfileInput.parse(raw)
        const companyId = axiomApi.getCompanyId()

        // Fetch current profile to fill in any fields the caller omitted.
        const current = await axiomApi.get<{
            company?: Record<string, unknown>
            data?:    Record<string, unknown>
        }>(`/companies/${companyId}`)

        const existing: Record<string, unknown> =
            (current as { company?: Record<string, unknown> }).company ??
            (current as { data?: Record<string, unknown> }).data ??
            (current as Record<string, unknown>)

        // Merge: caller-supplied values override existing ones.
        const body: Record<string, unknown> = {
            ...existing,
            name: input.name,
            ...(input.displayName !== undefined && { displayName: input.displayName }),
            ...(input.legalName   !== undefined && { legalName:   input.legalName }),
            ...(input.entityType  !== undefined && { entityType:  input.entityType }),
            ...(input.industry    !== undefined && { industry:    input.industry }),
            ...(input.tin         !== undefined && { tin:         input.tin }),
            ...(input.notes       !== undefined && { notes:       input.notes }),
            ...(input.contact     !== undefined && { contact: {
                ...(existing.contact as Record<string, unknown> ?? {}),
                ...input.contact,
            }}),
            ...(input.address     !== undefined && { address: {
                ...(existing.address as Record<string, unknown> ?? {}),
                ...input.address,
            }}),
            ...(input.fiscalYear  !== undefined && { fiscalYear: {
                ...(existing.fiscalYear as Record<string, unknown> ?? {}),
                ...input.fiscalYear,
            }}),
        }

        return await axiomApi.put(`/companies/${companyId}`, body)
    },
}

export const COMPANY_TOOLS = [
    getCompanyProfile,
    updateCompanyProfile,
]
