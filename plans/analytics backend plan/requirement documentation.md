 

User Analytics 

Functional Flow Specification — Developer Handoff 

Cocpit Professional — Individual User Module 

Prepared for: iOS / Android / Backend / AI Engineering 

Status: Draft for developer review — UI references to follow separately 

 

  

1. Overview 

Career Trajectory and Profile Analytics are two independent features accessible from the Home page. Neither feature depends on the other, and neither blocks access to the other. 

Feature 

Independent entry? 

Own eligibility check? 

Career Trajectory 

Yes — accessible without using Profile Analytics 

Yes — profile completion threshold 

Profile Analytics 

Yes — accessible without running Career Trajectory 

Yes — own analytics/eligibility flow 

  

Career Trajectory has two parallel experiences — Professional and Student — sharing the same page structure. Only the Journey section's data source changes between the two. 

2. Career Trajectory 

2.1 Purpose 

Career Trajectory helps a user understand their current position relative to a selected target role, identify skill gaps, understand their career or education journey, and receive a single recommended next action. The experience is personalized using the user's profile data and the selected target role. 

2.2 Eligibility 

User type 

Minimum profile completion 

Behavior if not met 

Working professional 

90% 

User is informed more profile information is required before analysis can run. 

Student/Fresher/Intern 

80% 

User is informed more profile information is required before analysis can run. 

  

Dev Note: System must determine working professional vs. student status before evaluating the threshold, since the two thresholds and Journey data sources differ. 

2.3 First-Time Flow 

User opens Career Trajectory from Home. 

System checks the user's profile completion percentage. 

System determines whether the user is a working professional or a student. 

If eligible, the user selects a target role. 

User initiates analysis via the Analyze action. 

Backend collects the relevant profile information. 

Backend performs the analysis workflow (see 2.6). 

Final analysis is stored as an immutable analysis snapshot. 

Results are returned to the UI. 

User sees the Career Trajectory results page. 

Note: After the first analysis, the results page becomes the default Career Trajectory experience for the user — the setup/eligibility screen is only shown before a first successful analysis, or when the user is not yet eligible. 

2.4 Analysis Frequency 

Career Trajectory analysis is manually initiated by the user, not automatic or scheduled. 

The user can run a new analysis once every 15 days. 

Example: Last analyzed Aug 8 → Next analysis available Aug 23. 

While a new analysis is unavailable, the user can still view the existing (most recent) analysis snapshot. 

Dev Note: The 15-day cooldown is enforced server-side against the last snapshot's creation timestamp. The client should surface both the last-analyzed date and the next-available date from the backend response, not calculate it locally. 

2.5 Target Role 

The user selects a target role before running analysis. This selection is the reference point for: 

Role taxonomy 

Skill requirements 

Skill alignment 

Role progress / readiness 

Recommendations 

Next best action 

Relevant opportunities 

The user can change the target role and run a new analysis once eligible again (subject to the 15-day cooldown). 

2.6 AI / Backend Workflow 

This section defines the exact split of responsibility between Gemini and the backend. This boundary is critical and must not be blurred in implementation. 

Step-by-step 

Backend collects the user's professional profile information: skills, work experience, education, resume data. 

Backend checks whether a valid role taxonomy for the selected target role already exists in the system cache. 

If no cached taxonomy exists, only the target role name is sent to Gemini to generate a structured role taxonomy. 

The user's professional profile data is sent to Gemini only for: extracting skills, normalizing skills, structuring skills, and estimating proficiency levels. 

Gemini returns structured analysis data only. 

Backend performs all scoring, skill-gap calculations, recommendations, ranking logic, and business rules. 

Backend stores the final analysis result and metadata as an immutable analysis snapshot. 

The processed snapshot is returned to the UI for display. 

 

 

Responsibility 

Owner 

Role taxonomy generation (cache miss only) 

Gemini (input: target role name only) 

Skill extraction / normalization / structuring / proficiency estimation 

Gemini (input: user profile data) 

Readiness scores 

Backend only 

Skill-gap percentages 

Backend only 

Rankings 

Backend only 

Recommendations / Next Best Action 

Backend only 

Business metrics 

Backend only 

  

Dev Note: Gemini must never be asked to calculate or return readiness scores, skill-gap percentages, rankings, or recommendations. The UI displays only the backend's final business output — the underlying AI workflow is never exposed to the client. 

2.7 Career Trajectory Result Page — Structure 

The result page contains, in order: 

Trajectory summary 

The Journey 

Skill alignment 

Current progress 

Next best action 

2.7.1 Trajectory Summary 

A short executive summary for users who won't read the full page. Must communicate: current direction, strong areas, major gaps, and relationship to the target role. Must remain concise — it should not reproduce detail shown in the sections below it. 

2.7.2 The Journey 

User type 

Journey source 

Structure 

Working professional (has current role) 

Work experience 

Current role → Previous role(s) → Target role 

Working professional (no current role, has previous) 

Work experience 

Most recent previous role → Earlier role (only one) → Target role 

Working professional (no current, no previous) 

— 

Target role only 

Student/Fresher/Intern 

 

Education 

Current education → Previous education (if relevant) → Target role 

  

Dev Note: A most-recent previous role must be classified as a previous role, never as a current role. The system must not fabricate a current role or infer/display a reason why the user is not currently employed. Students must not be shown an artificial work-experience journey. 

Journey descriptions are optional. If a meaningful description is available, show a concise summary of no more than two lines — do not generate filler description text purely to fill the UI. The Journey should summarize meaningful information rather than reproduce the user's resume verbatim. 

2.7.3 Skill Alignment 

Shows how closely the user's current skills match the skills required for the target role, expressed as a single percentage (e.g., ‘70% aligned’). 

The permanent UI shows only the current alignment percentage — kept simple by default. 

On hover/interaction with the visualization, a popup shows per-skill detail: Skill name | Current | Targeted (e.g., P&L management | 40% | 85%). 

Dev Note: Do not render current vs. target values as permanent on-screen text for every skill — that detail is interaction-revealed only, per the design intent of keeping the base UI simple. 

2.7.4 Current Progress 

A single percentage representing overall progress toward the target role (e.g., ‘68% — Progress toward your target role’), calculated from the user's relevant experience and skills relative to the target role. 

Note: Current Progress is distinct from Skill Alignment. Skill Alignment answers “How closely do my current skills match the target role?” Current Progress answers “How far along am I toward the target role overall?” based on experience and skills combined. These are two separate calculations and must not be conflated in the UI or backend logic. 

2.7.5 Role Readiness Logic 

Role readiness/progress calculation should primarily weight: 

Relevant skills 

Relevant experience 

Education may contribute contextual information but must not automatically penalize a user whose education doesn't directly match the target role. Example: a user with an unrelated degree but strong relevant experience and skills should not be scored as unready purely because of the degree mismatch. 

2.7.6 Next Best Action 

Identifies the single most useful action for the user to take next. Only one primary action is shown — the four types below are a priority hierarchy, not four equal options. 

Priority 

Type 

Shown when… 

Example 

1 (highest) 

Job 

A suitable job opportunity exists and the user is sufficiently aligned with the target role. 

“Apply for VP of Marketing at XYZ” → View job 

2 

Connection 

A job isn't the appropriate next action, but a meaningful professional connection opportunity exists. 

“Connect with a marketing leader in your target industry” 

3 

Channel 

A relevant professional channel/community is the best next step. 

Subscribe to a relevant organization/channel 

4 (open category) 

Other 

Covers development actions: course, certification, project, skill-building, or other professional development. 

“Enroll in Strategic Finance for Marketers” 

  

Dev Note: “Other” must remain an open, generic category in the data model — do not hardcode it as “Course”, since it also covers certifications, projects, and other development activity types. 

A separate “Recommended Jobs” section is not required and should not be built — job recommendations are already surfaced through the Next Best Action hierarchy, and showing the same job twice should be avoided. 

2.7.7 Profile Analytics Snapshot (within Career Trajectory) 

A compact snapshot of Profile Analytics can appear toward the bottom of the Career Trajectory results page. This is supporting information only and must not visually compete with the main Career Trajectory analysis above it. 

3. Profile Analytics 

3.1 Purpose 

Profile Analytics helps users understand how their professional presence and content are performing. It contains four tabs: Overview, Content, Audience, and Opportunities. A single date filter (Custom/ Last 7 days / Last 30 days / All time) applies consistently across all four tabs. 

3.2 Overview Tab 

Element 

Definition 

Overall reach 

Total number of people reached through the user's content/activity. 

Profile views 

Count of profile visits. 

Profile strength 

Percentage completion of the user's profile, with a prompt on what to add to reach 100%. 

Search appearances 

Number of times the user's profile appeared in platform search results, with % change. 

Connection requests 

Count of connection requests received in the selected period (includes Accepted, Rejected, and Withdrawn — see Section 4 counting rules). 

Follower growth 

Count of new followers gained via the Follow action, with % change. 

Opportunity views 

Count of profile views from a qualifying hiring/recruiting or organization context, with trend indicator. 

Resume views 

Count of resume views, with trend indicator. 

Resume downloads 

Count of resume downloads (Download button click only), with % change. 

Insights 

Short system-generated callouts explaining what the analytics system identified across the above metrics — not an additional performance metric. 

3.3 Content Tab 

3.3.1 Content Format Performance 

Aggregated views broken down by post format: Articles, Media, Polls, Text. 

3.3.2 Top-Performing Posts 

Ranked by engagement and professional impact by default. 

Filterable by: Top performing / Most viewed / Most liked / Most shared. 

Same global date filter applies (Custom/ Last 7 days / Last 30 days / All time). 

Posts are ranked by view count in descending order, and only the top 5 highest-viewed posts are displayed in the Top-Performing Posts list. 

3.3.3 Post Detail View 

Opened by selecting a post from the Top-Performing list. Contains: 

Post preview 

Views, Likes, Comments, Shares, Saves, Engagement rate 

Total reach 

Direct impact: Profile visits, New followers, Recruiter/opportunity views 

Geographic distribution 

Industry distribution 

Dev Note: The post detail view should be framed around reach and direct impact (what this post caused), not purely as an engagement-count summary. 

3.4 Audience Tab 

Element 

Definition 

Overall reach 

Same metric as Overview, contextualized within audience analysis. 

Profile views 

Same metric as Overview, contextualized within audience analysis. 

Engagement rate 

Same metric as Overview, contextualized within audience analysis. 

Audience location 

Two tabs: Countries and Cities. Shows the top two countries or top 4 cities depending on the selected tab. 

Audience industries 

Based on each viewer's selected profile industry. No industry selected → grouped under “Other”. 

Insights 

System-generated callouts summarizing audience patterns; concise, not a metric duplicate. 

3.5 Opportunities Tab 

This tab replaces what was previously called the “Recruiter” section. Final labels: 

Opportunity activity 

Repeat organization visitors 

Top organizations 

Organization industries 

Insights 

Dev Note: Use “Organization” terminology throughout — never “Company” — since the entity type covers companies, institutes, and other organization account types. 

3.5.1 Opportunity Activity 

Counts profile views that originate from a qualifying hiring/recruiting or organization-related context. 

Note: Example: A company posts a job → the company views User A's profile through the applications list → that view is counted as an opportunity/recruiter view for User A. A regular user viewing the profile via normal search is NOT counted as opportunity activity. 

3.5.2 Repeat Organization Visitors 

Organizations that have viewed the user's profile more than once within the selected period, counted as repeat visitors. 

3.5.3 Top Organizations 

Ranked by profile visit count. Each row shows: 

Organization name 

Visit count 

Relevant active role, if one exists (job title) — otherwise “No active roles” 

Dev Note: An organization does not need to be actively recruiting to appear in this list — any qualifying organization-context view counts. Regular individual users are never included in this list. 

3.5.4 Organization Industries 
If a viewer has no industry set on their profile, their view/interaction is still counted, but grouped and displayed under an "Other" bucket in the distribution — not excluded from the total. 

Industries of the organizations that viewed the profile through qualifying organization/opportunity activity — shows which industries are most interested in the user's profile. 

3.5.5 Insights 

Same concept as Overview insights: concise, system-generated, and non-duplicative of the raw metrics shown above them. 

4. Metric Definitions (Precise Counting Rules) 

These rules resolve ambiguity that is easy to get wrong during implementation — apply them exactly as specified. 

Metric 

Counting rule 

Connection requests 

Counted based on requests received during the selected period. The count includes requests regardless of final status — Accepted, Rejected, and Withdrawn all remain part of the historical count for that period. Status changes do not retroactively change the count. 

Follower growth 

Based on the Follow action only. Follow and Connect are separate actions and tracked as separate metrics, even if the same two users eventually both follow and connect with each other. 

Resume downloads 

A direct action metric — counted only when a user clicks the Download button (not on view). 

Recruiter / opportunity views 

Counted only when a profile is viewed from a qualifying hiring/recruiting context (e.g., via an applications list). Views from search or other non-hiring surfaces are not counted, even if the viewer is an organization account. 

Profile industry 

Sourced from the Industry field on the viewer's profile. If unset, the viewer is grouped under “Other” for all industry-based analytics (audience industry, organization industries, etc.). 

5. User Journeys (for Flow Diagrams) 

The sections below describe each navigable path end-to-end. UI wireframes for these flows will be shared separately — this section defines the underlying step sequence and decision points for reference during flow-diagram creation. 

5.1 Home → Feature Entry 

User opens Home. 

User sees two independent entry points: Career trajectory, Profile analytics. 

User may enter either feature independently, in any order. 

5.2 Career Trajectory — Full Journey 

Home → Career trajectory 

Eligibility check (profile completion vs. threshold) 

System resolves Professional or Student experience 

User selects target role 

User taps Analyze 

Backend collects profile data 

Backend performs role-taxonomy cache check 

AI skill extraction / normalization / proficiency estimation (Gemini) 

Backend calculates skill alignment, progress, gaps, recommendations, and business logic 

Immutable analysis snapshot created 

Career trajectory results shown: Trajectory summary → The Journey → Skill alignment → Current progress → Next best action → Profile analytics snapshot 

User can revisit the existing snapshot at any time 

After 15 days, user may manually trigger a new analysis 

5.2.1 Professional variant 

Eligibility threshold: profile completion ≥ 90%. Journey shows: Current role (if available) → Previous role(s) (if available) → Target role. If there is no current or previous role, Target role is still shown alone. 

5.2.2 Student variant 

Eligibility threshold: profile completion ≥ 80%. Journey shows: Education journey → Target role, replacing work experience as the journey context entirely. 

5.3 Profile Analytics — Full Journey 

Home → Profile analytics → Overview (default tab). From Overview, the user can navigate to Content, Audience, or Opportunities. The date filter (custom/ Last 7 days / Last 30 days / All time) persists across all four tabs. 

5.3.1 Content journey 

Profile analytics → Content 

Review content format performance 

Review top-performing posts list 

Apply ranking filter: Top performing / Most viewed / Most liked / Most shared 

Apply date filter 

Select a post → Post details 

View: Views, Likes, Comments, Shares, Saves, Engagement rate 

View: Total reach, Direct impact (Profile visits, New followers, Opportunity/recruiter views) 

View: Geographic distribution, Industry distribution 

5.3.2 Audience journey 

Profile analytics → Audience 

View Overall reach, Profile views, Engagement rate 

Toggle Countries / Cities tab — top two shown per tab 

View Audience industries 

View Insights 

5.3.3 Opportunities journey 

Profile analytics → Opportunities 

View Opportunity activity 

View Repeat organization visitors 

View Top organizations (Organization, Visits, Relevant job title or “No active roles”) 

View Organization industries 

View Insights 

6. Terminology Reference 

Use these exact labels in UI copy, API field naming, and analytics event naming for consistency. 

Area 

Approved terms 

Profile Analytics tabs 

Overview, Content, Audience, Opportunities 

Audience tab fields 

Overall reach, Profile views, Engagement rate, Countries, Cities, Audience industries, Insights 

Opportunities tab fields 

Opportunity activity, Repeat organization visitors, Top organizations, Organization industries, Insights 

Entity naming 

“Organization” — never “Company” — since this entity type includes companies, institutes, and other organization account types. 

7. Core Product Principle 

The product must not expose the complexity of the AI/backend system to the user. The end-to-end user experience should read as a single, simple narrative: 

My profile and target role were analyzed → This is where I currently stand → These are my skill gaps → This is my progress → This is the best next action → Here is how my professional presence is performing. 

8. Open Items / Pending Inputs 

UI screens/wireframes for all flows above to be shared separately and cross-referenced against this document. 

Resume upload/parsing flow is referenced (Resume views, Resume downloads) but not yet separately specified — confirm whether a dedicated resume module spec is needed. 

Notification/channel triggers for Next Best Action recommendations (e.g., does a new Job/Connection/Channel recommendation trigger a push notification?) to be confirmed against the Notifications spec. 

Company-side visibility into a user's Opportunity Activity (i.e., what the organization sees on their end when their view counts toward a user's analytics) is not yet defined — to be cross-checked against the Company Page Analytics spec. 

 