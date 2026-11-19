-- ==============================================================================
-- UAT Migration v1.10.0
-- Target Database: cocpit_backend_uat (also applied to staging/production)
-- Prepared Date:  2026-11-17
-- Description:
--   1. User & Organization Verification Lifecycle (PR #566 / Migration 021):
--      - Adds document_type, rejection_reason, and notes to user_verifications table.
--      - Ensures organization_documents table has status column defaulting to 'PENDING'.
--   2. Organization Sector Field & Index (PR #571):
--      - Adds sector column (VARCHAR(100)) to organizations table.
--      - Creates partial index idx_organizations_sector for sector filtering.
--   3. Partial Trigram Search Indexes on Organizations (PR #571 / Migration 021):
--      - Creates GIN trigram indexes on organizations(headline) and organizations(description).
--   4. Purge Industry Subtypes Hierarchy & View Recreation (PR #571 / Migration 022):
--      - Drops parent_id and display_order from industries_master.
--      - Drops industry_sub_type_id from organizations.
--      - Recreates dependent views (active_organizations, organization_display_profiles,
--        active_post_likes, active_post_comments, active_comment_likes).
--   5. Seed Unified Master Industries List (PR #571 / Migration 023):
--      - Seeds 395 industry entries into industries_master with case-insensitive deduplication.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. User & Organization Verification Lifecycle Columns
-- ------------------------------------------------------------------------------

-- 1.1. Add verification review lifecycle columns to user_verifications
ALTER TABLE user_verifications 
    ADD COLUMN IF NOT EXISTS document_type VARCHAR(100),
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- 1.2. Ensure organization_documents has status column
ALTER TABLE organization_documents
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'PENDING';

-- ------------------------------------------------------------------------------
-- 2. Organization Sector Field & Index
-- ------------------------------------------------------------------------------

-- 2.1. Add sector column to organizations
ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS sector VARCHAR(100) DEFAULT NULL;

-- 2.2. Create partial index on sector
CREATE INDEX IF NOT EXISTS idx_organizations_sector
    ON organizations (sector) 
    WHERE sector IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 3. Trigram Indexes for Organizations Headline & Description
-- ------------------------------------------------------------------------------

-- 3.1. Ensure pg_trgm extension exists
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 3.2. Partial GIN trigram index on organizations headline
CREATE INDEX IF NOT EXISTS idx_organizations_headline_trgm 
    ON organizations USING GIN (headline gin_trgm_ops) 
    WHERE headline IS NOT NULL;

-- 3.3. Partial GIN trigram index on organizations description
CREATE INDEX IF NOT EXISTS idx_organizations_description_trgm 
    ON organizations USING GIN (description gin_trgm_ops) 
    WHERE description IS NOT NULL;

-- ------------------------------------------------------------------------------
-- 4. Purge Industry Sub-Types & Recreate Dependent Views
-- ------------------------------------------------------------------------------

-- 4.1. Drop index on industries_master.parent_id if exists
DROP INDEX IF EXISTS idx_industries_master_parent_id;

-- 4.2. Drop parent_id and display_order columns from industries_master
ALTER TABLE industries_master
    DROP COLUMN IF EXISTS parent_id CASCADE,
    DROP COLUMN IF EXISTS display_order CASCADE;

-- 4.3. Drop index on organizations.industry_sub_type_id if exists
DROP INDEX IF EXISTS idx_organizations_industry_sub_type_id;

-- 4.4. Drop industry_sub_type_id column from organizations
-- NOTE: Dropping a column on organizations with CASCADE drops dependent views:
-- active_organizations, organization_display_profiles, active_post_likes,
-- active_post_comments, active_comment_likes. We recreate them immediately.
ALTER TABLE organizations
    DROP COLUMN IF EXISTS industry_sub_type_id CASCADE;

-- 4.5. Recreate active_organizations view
CREATE OR REPLACE VIEW active_organizations AS 
SELECT * FROM organizations 
WHERE (is_deleted IS FALSE OR is_deleted IS NULL) 
  AND (is_suspended IS FALSE OR is_suspended IS NULL) 
  AND (is_deactivated IS FALSE OR is_deactivated IS NULL);

-- 4.6. Recreate organization_display_profiles view
CREATE OR REPLACE VIEW organization_display_profiles AS
SELECT 
    org_id,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN name 
        ELSE 'Deleted Page' 
    END AS name,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN slug 
        ELSE 'deleted_page' 
    END AS slug,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN logo_url 
        ELSE NULL 
    END AS logo_url,
    CASE 
        WHEN deletion_execute_at IS NULL AND is_deleted = FALSE AND is_deactivated = FALSE THEN headline 
        ELSE 'This page has been deactivated' 
    END AS headline,
    entity_type
FROM organizations;

-- 4.7. Recreate active views for likes and comments
CREATE OR REPLACE VIEW active_post_likes AS
SELECT pl.* 
FROM post_likes pl
LEFT JOIN active_users au ON au.user_id = pl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = pl.org_id
WHERE (pl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_post_comments AS
SELECT pc.*
FROM post_comments pc
LEFT JOIN active_users au ON au.user_id = pc.author_id
LEFT JOIN active_organizations ao ON ao.org_id = pc.author_org_id
WHERE (pc.author_org_id IS NULL AND au.user_id IS NOT NULL)
   OR (pc.author_org_id IS NOT NULL AND ao.org_id IS NOT NULL);

CREATE OR REPLACE VIEW active_comment_likes AS
SELECT cl.*
FROM comment_likes cl
LEFT JOIN active_users au ON au.user_id = cl.user_id
LEFT JOIN active_organizations ao ON ao.org_id = cl.org_id
WHERE (cl.org_id IS NULL AND au.user_id IS NOT NULL)
   OR (cl.org_id IS NOT NULL AND ao.org_id IS NOT NULL);

-- ------------------------------------------------------------------------------
-- 5. Seed Unified Master Industries List (395 Entries, Deduplicated)
-- ------------------------------------------------------------------------------

INSERT INTO industries_master (industry_name)
SELECT t.name
FROM (VALUES
  ('5G Technology'),
  ('Accounting'),
  ('Accounting Technology'),
  ('Advertising Technology (AdTech)'),
  ('Aerospace'),
  ('Aerospace and Defense'),
  ('Aerospace Manufacturing'),
  ('Agribusiness'),
  ('Agricultural Equipment'),
  ('Agricultural Technology (AgriTech)'),
  ('Agriculture and Food'),
  ('Aircraft Engineering'),
  ('Aircraft Maintenance'),
  ('Airlines & Aviation'),
  ('Alternative Dispute Resolution'),
  ('Alternative Medicine'),
  ('Amusement Parks'),
  ('Animal Husbandry'),
  ('Animation'),
  ('Apparel & Fashion'),
  ('Architecture & Planning'),
  ('Architecture Consulting'),
  ('Artificial Intelligence (AI)'),
  ('Asset Management'),
  ('Auditing'),
  ('Augmented Reality (AR)'),
  ('Auto Components'),
  ('Auto Parts'),
  ('Automobile'),
  ('Automobile Dealerships'),
  ('Automobile Repair & Maintenance'),
  ('Automotive'),
  ('Automotive and Mobility'),
  ('Automotive Engineering'),
  ('Automotive Manufacturing'),
  ('Automotive Services'),
  ('Automotive Technology'),
  ('Aviation & Aerospace Services'),
  ('Aviation Company'),
  ('Aviation Manufacturing'),
  ('Banking'),
  ('Battery Manufacturing'),
  ('Beauty & Wellness'),
  ('Beauty Technology'),
  ('Beauty, Personal Care and Lifestyle'),
  ('Biotechnology'),
  ('Blockchain Technology'),
  ('Brand Strategy'),
  ('Branding'),
  ('Broadband Services'),
  ('Broadcast Media'),
  ('Brokerage Services'),
  ('Building Construction'),
  ('Building Materials'),
  ('Business Advisory'),
  ('Business Process Outsourcing (BPO)'),
  ('Business Supplies & Equipment'),
  ('Capital Markets'),
  ('Carbon Management'),
  ('Catering Services'),
  ('Ceramics & Concrete'),
  ('Chemicals'),
  ('Civic & Social Organizations'),
  ('Civil Engineering'),
  ('Clinical Research'),
  ('Clinics'),
  ('Cloud Computing'),
  ('Cold Chain Logistics'),
  ('Colleges'),
  ('Commercial Real Estate'),
  ('Commercial Vehicles'),
  ('Community Development'),
  ('Computer & Network Security'),
  ('Computer Hardware'),
  ('Computer Networking'),
  ('Computer Software'),
  ('Construction'),
  ('Construction and Real Estate'),
  ('Consumer Electronics'),
  ('Consumer Goods'),
  ('Consumer Services'),
  ('Content Creation'),
  ('Corporate Services'),
  ('Corporate Training'),
  ('Cosmetics'),
  ('Courier Services'),
  ('Credit & Lending'),
  ('Cryptocurrency & Digital Assets'),
  ('Cybersecurity'),
  ('Dairy'),
  ('Data Centers'),
  ('Data Science & Analytics'),
  ('Defense & Military Technology'),
  ('Defense & Space'),
  ('Defense Electronics'),
  ('Defense Manufacturing'),
  ('Dental Practice'),
  ('Dentistry'),
  ('Design'),
  ('Diagnostics'),
  ('Digital Marketing'),
  ('Digital Transformation Consulting'),
  ('Drone Technology'),
  ('Dropshipping'),
  ('E-commerce'),
  ('E-commerce Platforms'),
  ('E-Learning'),
  ('Education'),
  ('Education Management'),
  ('Educational Consulting'),
  ('Educational Technology (EdTech)'),
  ('Elderly Care'),
  ('Electric Vehicle Charging Infrastructure'),
  ('Electric Vehicles (EV)'),
  ('Electrical & Electronic Manufacturing'),
  ('Electronics'),
  ('Energy and Utilities'),
  ('Energy Storage'),
  ('Engineering Procurement & Construction (EPC)'),
  ('Entertainment Management'),
  ('Environmental Organizations'),
  ('Environmental Services'),
  ('Event Management'),
  ('Event Services'),
  ('Executive Search'),
  ('Facilities Services'),
  ('Farming'),
  ('Fashion Accessories'),
  ('Fast-Moving Consumer Goods (FMCG)'),
  ('Fiber Optic Networks'),
  ('Film Production'),
  ('Finance'),
  ('Financial Planning'),
  ('Financial Services'),
  ('Financial Technology'),
  ('Fintech Technology'),
  ('Fisheries'),
  ('Fisheries Processing'),
  ('Fitness'),
  ('Fitness Centers'),
  ('Fleet Management'),
  ('Floriculture'),
  ('Food & Beverages'),
  ('Food Distribution'),
  ('Food Packaging'),
  ('Food Processing'),
  ('Food Production'),
  ('Food Retail'),
  ('Food Technology'),
  ('Footwear'),
  ('Foreign Exchange'),
  ('Foundations'),
  ('Foundries'),
  ('Fragrance & Perfumes'),
  ('Freight Forwarding'),
  ('Fundraising'),
  ('Furniture'),
  ('Furniture Manufacturing'),
  ('Game Development'),
  ('Gaming'),
  ('Gaming & Esports'),
  ('Glass'),
  ('Government Administration'),
  ('Government and Non-Profit'),
  ('Government Relations'),
  ('Graphic Design'),
  ('Gyms'),
  ('Haircare'),
  ('Health & Wellness'),
  ('Health Insurance'),
  ('Healthcare and Life Sciences'),
  ('Healthcare Staffing'),
  ('Healthcare Technology'),
  ('Heavy Equipment Manufacturing'),
  ('Higher Education'),
  ('Home Appliances'),
  ('Home Decor'),
  ('Home Healthcare'),
  ('Horticulture'),
  ('Hospitality'),
  ('Hospitality, Travel and Leisure'),
  ('Hospitals'),
  ('Hospitals & Healthcare'),
  ('Hotels & Resorts'),
  ('Human Resources'),
  ('Humanitarian Organizations'),
  ('Hydropower'),
  ('Import & Export'),
  ('Industrial Automation'),
  ('Industrial Engineering'),
  ('Industrial Equipment'),
  ('Industrial Machinery'),
  ('Influencer Marketing'),
  ('Information and Internet'),
  ('Information Technology'),
  ('Infrastructure Development'),
  ('Insurance'),
  ('Intellectual Property Services'),
  ('Interior Architecture'),
  ('Interior Design'),
  ('International Affairs'),
  ('International Organizations'),
  ('Internet'),
  ('Internet of Things (IoT)'),
  ('Internet Service Providers (ISP)'),
  ('Investment Banking'),
  ('Investment Firms'),
  ('Investment Management'),
  ('IT Consulting'),
  ('IT Hardware & Networking'),
  ('IT Infrastructure'),
  ('IT Services and IT Consulting'),
  ('Jewellery'),
  ('Jewellery Manufacturing'),
  ('Judiciary'),
  ('Knowledge Process Outsourcing (KPO)'),
  ('Laboratory Services'),
  ('Landscaping'),
  ('Language Schools'),
  ('Last-Mile Delivery'),
  ('Law Enforcement'),
  ('Law Practice'),
  ('Legal Service'),
  ('Legislative Office'),
  ('Leisure'),
  ('Libraries'),
  ('Lifestyle Products'),
  ('Logistics & Supply Chain'),
  ('Logistics and Transport'),
  ('Luxury Goods & Jewellry'),
  ('Luxury Retail'),
  ('Machine Learning'),
  ('Machinery'),
  ('Management Consulting'),
  ('Manufacturing'),
  ('Maritime'),
  ('Market Research'),
  ('Marketing & Advertising'),
  ('Marketing, Media and Entertainment'),
  ('Mechanical Engineering'),
  ('Media Houses'),
  ('Media Production'),
  ('Medical Devices'),
  ('Medical Equipment Manufacturing'),
  ('Medical Practice'),
  ('Medical Tourism'),
  ('Mental Healthcare'),
  ('Metal Fabrication'),
  ('Microfinance'),
  ('Military'),
  ('Mining & Metals'),
  ('Mobility Services'),
  ('Mobility Technology'),
  ('Motion Pictures & Film'),
  ('Museums & Institutions'),
  ('Music'),
  ('NBFC'),
  ('Network Infrastructure'),
  ('Newspapers'),
  ('Non-Profit Organization Management'),
  ('Nuclear Energy'),
  ('Nursing'),
  ('Nutraceuticals'),
  ('Oil & Energy'),
  ('Online Education'),
  ('Online Marketplaces'),
  ('Online Media'),
  ('Organic Farming'),
  ('Outsourcing & Offshoring'),
  ('Package & Freight Delivery'),
  ('Packaging & Containers'),
  ('Paper & Forest Products'),
  ('Payment Gateways'),
  ('Payment Solutions'),
  ('Personal Care'),
  ('Personal Care Products'),
  ('Personal Grooming'),
  ('Pharmaceutical Manufacturing'),
  ('Pharmaceuticals'),
  ('Philanthropy'),
  ('Photography'),
  ('Plastics'),
  ('Podcast Production'),
  ('Port Operations'),
  ('Poultry Farming'),
  ('Precision Engineering'),
  ('Primary & Secondary Education'),
  ('Printing'),
  ('Private Banking'),
  ('Private Equity'),
  ('Professional Services'),
  ('Professional Training & Coaching'),
  ('Project Management'),
  ('Property Development'),
  ('Property Management'),
  ('Public Infrastructure'),
  ('Public Policy'),
  ('Public Relations & Communications'),
  ('Public Safety'),
  ('Public Transportation'),
  ('Publishing'),
  ('Quantum Computing'),
  ('Railroad Manufacturing'),
  ('Ranching'),
  ('Real Estate'),
  ('Real Estate Investment'),
  ('Recreational Facilities & Services'),
  ('Recruitment Consulting'),
  ('Rehabilitation Services'),
  ('Religious Institutions'),
  ('Renewable Energy'),
  ('Renewable Energy Equipment'),
  ('Renewables & Environment'),
  ('Research'),
  ('Research Institutions'),
  ('Restaurants'),
  ('Retail and Trade'),
  ('Ride-Hailing'),
  ('Robotics'),
  ('Rubber Manufacturing'),
  ('SaaS'),
  ('Salons & Spas'),
  ('Satellite Communications'),
  ('Satellite Manufacturing'),
  ('Schools'),
  ('Security & Investigations'),
  ('Semiconductors'),
  ('Shipbuilding'),
  ('Shipping'),
  ('Skill Development'),
  ('Skincare'),
  ('Smart Buildings'),
  ('Social Services'),
  ('Software & SaaS'),
  ('Software Development'),
  ('Software Testing & Quality Assurance'),
  ('Solar Energy'),
  ('Space Exploration'),
  ('Space Technology'),
  ('Sporting Goods'),
  ('Sports'),
  ('Sports Clubs'),
  ('Sports Management'),
  ('Staffing & Recruiting'),
  ('Staffing and Outsourcing'),
  ('Stock Broking'),
  ('Study Abroad Consulting'),
  ('Supermarkets'),
  ('Supply Chain Technology'),
  ('Sustainability Consulting'),
  ('Talent Agencies'),
  ('Talent Management'),
  ('Tax Consulting'),
  ('Technology'),
  ('Telecom'),
  ('Telecommunications'),
  ('Telecommunications Software'),
  ('Television Production'),
  ('Test Preparation'),
  ('Textile Manufacturing'),
  ('Theme Parks'),
  ('Think Tanks'),
  ('Tour Operators'),
  ('Tourism Services'),
  ('Trading Companies'),
  ('Training Institutes'),
  ('Translation & Localization'),
  ('Transportation'),
  ('Travel & Tourism'),
  ('Travel Agencies'),
  ('Trucking & Railroad'),
  ('Two-Wheeler Manufacturing'),
  ('Universities'),
  ('Unmanned Aerial Vehicles (UAV)'),
  ('Urban Development'),
  ('Urban Planning'),
  ('Utilities'),
  ('Vacation Rentals'),
  ('Vehicle Rental & Leasing'),
  ('Venture Capital'),
  ('Veterinary Services'),
  ('Virtual Reality (VR)'),
  ('Vocational Training'),
  ('Warehousing'),
  ('Waste Management'),
  ('Water Supply'),
  ('Water Treatment'),
  ('Wealth Management'),
  ('Web3'),
  ('Wedding Planning'),
  ('Wholesale'),
  ('Wholesale Distribution'),
  ('Wind Energy'),
  ('Wireless'),
  ('Writing & Editing')
) AS t(name)
WHERE NOT EXISTS (
  SELECT 1 FROM industries_master im
  WHERE LOWER(TRIM(im.industry_name)) = LOWER(TRIM(t.name))
);

COMMIT;
