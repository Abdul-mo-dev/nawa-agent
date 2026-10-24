# GenOffice Privacy

Last updated: October 24, 2026

GenOffice opens, edits, and saves documents locally. Document editing does not
upload files to GenOffice. AI features require a network connection and send
requests only when you use them.

Local HTML previews block remote resources, connections and external popups by
default. You can enable remote content for an individual open file; its scripts
and resources can then contact remote services and transmit content available to
that page. Closing the file clears this permission. This setting does not grant
access to Nawa's privileged APIs. Optional search, media, account and update
features also contact their configured services when used or enabled.

**Settings → AI & Models** can download llama.cpp engines from GitHub and GGUF
weights from public Hugging Face repositories when requested. Catalog searches
send the entered search term or repository ID to those services. These requests
do not include document content. Managed local servers listen on `127.0.0.1`;
using them for chat or embeddings sends the selected context to that local
process. Models and profiles are stored locally, separately from the installer.

Saved remote API profiles can send chat context or extracted file text and search
queries to a user-configured OpenAI-compatible server. Remote embedding profiles
require explicit permission for this transmission. Connection tests use synthetic
probes. Profile API keys use OS-protected storage; the settings interface receives
saved-key indicators instead of stored key values.

The first-run runtime setup also downloads the official chat template and
embedding projector from Hugging Face, LibreOffice from The Document Foundation,
and Microsoft's Visual C++ runtime from Microsoft when needed. These setup
downloads do not include document content. Completed assets and resumable partial
downloads remain in Nawa's per-user storage. Windows manages OCR recognition
languages; the setup screen can open Windows language settings.

## Usage analytics

Usage analytics is enabled by default in packaged official builds, including
the initial app launch before the onboarding notice is shown. Onboarding
explains what is collected and where to turn it off.

You can disable reporting at any time under **Settings → General → Send
anonymous usage statistics**. An explicit opt-out is remembered and stops all
subsequent analytics events.

### Events and parameters

When enabled, the app sends these events:

- `install_first_launch` — marks the first analytics-enabled use of a newly
  assigned anonymous `client_id`; used for retention cohorts
- `app_launch` — no event-specific parameter
- `file_open` — `ext`, the file extension such as `docx` or `xlsx`
- `file_new` — `kind`, one of `docx`, `xlsx`, `pptx`, `md`, or `pdf`
- `login_click` — no event-specific parameter
- `login_success` — no event-specific parameter

Every event includes:

- `app_version`
- `platform`
- `os_version`
- `ui_lang`
- a per-process `session_id` derived from the process start time
- `engagement_time_msec` with the fixed value `100`

When available, the payload also includes `country_id`, the two-letter country
code from the operating system's regional locale. This can differ from the
user's physical location.

The Google Analytics 4 payload also uses a random install UUID as `client_id`.
The country code is sent through GA4's country-only `user_location` field; the
app does not send a city or region. Neither identifier is a Genspark account or
email address.

## Network information

Events are sent to Google Analytics 4 using the Measurement Protocol over
HTTPS. As the HTTPS recipient, Google necessarily sees the connection's public
IP address and transport metadata, and may use them for coarse geolocation and
security or spam-abuse processing. GenOffice does not add an IP address to the
event payload.

## Data not collected by analytics

GenOffice analytics never sends:

- document content
- file names
- file paths
- Genspark account identity
- email addresses

The analytics metadata is injected only into packaged official builds and is
not part of this repository. Source builds and forks without that packaged
metadata install a no-op tracker and send no usage analytics; all features work
the same.
