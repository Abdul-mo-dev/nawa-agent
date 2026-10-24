# Approve a PC for Nawa

Use [Approve-NawaPC.ps1](Approve-NawaPC.ps1) on the administrator PC to turn a
received `.nawa-request` file into a signed `.nawa-license` file.

You need Windows, Node.js **22.12 or newer**, this project folder, and the Windows
account that owns the signing key. The signing key has already been initialized
on the development PC. Open a normal PowerShell window using that account.
There is no need to run an app build or `npm install` for this script.

## 1. Receive the request

Ask the target user to run the Nawa installer, click **Export device request**,
and send you the saved `.nawa-request` file by email, USB, or a shared folder.
Save it somewhere convenient, such as Downloads.

The request must come from the target PC and the Windows account that will run
Nawa. Approval covers that combination.

## 2. Run the guided script

Open PowerShell in the project folder and run. For your current checkout:

```powershell
cd C:\Users\abdul\source\repos\Nawa-agent
.\Approve-NawaPC.ps1
```

Adjust the folder path if you move the project.

Enter the following when prompted:

1. The full path to the received `.nawa-request` file. Pasted paths with quotes
   and paths containing spaces are supported.
2. An owner / PC label, for example `Ahmed / PC-01`.
3. An optional expiry date such as `2027-12-31`. Press Enter for no expiry.

The script signs the request with your existing key and saves a license beside
it. For example, `Downloads\PC-01.nawa-request` produces
`Downloads\PC-01.nawa-license`. Existing files are preserved; use `-OutputPath`
with another filename when reissuing a license.

A date-only expiry remains valid through **23:59:59.999 UTC** on that date.
Explicit timestamps must include a timezone, for example
`2027-12-31T23:59:59.000Z`.

If PowerShell blocks the script, you can run it for this invocation with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Approve-NawaPC.ps1
```

This does not change your persistent execution policy. An organization-enforced
policy can still require its approved way of running scripts.

## 3. Return the license

Send the generated `.nawa-license` file back to the user. They run setup again
if necessary, click **Import license**, and select that file. Installation
continues after Nawa verifies it. Keep the signing key and its backup on the
administrator side; only the generated license needs to be returned.

## Approve using parameters

You can provide the details directly instead of using prompts:

```powershell
.\Approve-NawaPC.ps1 -RequestPath "$env:USERPROFILE\Downloads\PC-01.nawa-request" -Licensee "Ahmed / PC-01"
```

With an expiry and another output filename:

```powershell
.\Approve-NawaPC.ps1 -RequestPath "$env:USERPROFILE\Downloads\PC-01.nawa-request" -Licensee "Ahmed / PC-01" -ExpiresAt "2027-12-31" -OutputPath "$env:USERPROFILE\Downloads\PC-01-renewed.nawa-license"
```

The destination folder must already exist. Relative paths are resolved from
your PowerShell working folder; the script finds its administrator tool using
its own location. Keep it in this project beside the `tools` folder.

Add `-WhatIf` to preview the file paths, label, and expiry without signing or
writing a license. Preview does not verify the request signature. Add
`-NonInteractive` when automating with explicit parameters: missing values fail
instead of waiting for input. Exit code `0` means success (or preview);
nonzero means failure.

If the target PC requested a software-backed key because TPM was unavailable,
the administrator tool rejects it by default. After deciding to approve that
alternative, add `-AllowSoftwareKey` to the command. It does not weaken existing
TPM approvals or change the requested PC/account.

## View issued approvals

```powershell
.\Approve-NawaPC.ps1 -List
```

This displays the issuance ledger. Deleting a ledger entry does not revoke an
offline license that has already been issued.

## Back up the signing key

Choose a new file outside this project:

```powershell
.\Approve-NawaPC.ps1 -BackupKey -OutputPath "$env:USERPROFILE\Nawa-approval-key-backup.pem"
```

The tool asks for a password of at least 16 characters and confirmation, without
displaying it. Keep the encrypted backup and password privately and separately.
Move the backup to your chosen secure backup location. Backup requires an
interactive terminal; `-NonInteractive` cannot supply the password.

The live key is protected for the owning Windows account at:

```text
%LOCALAPPDATA%\Nawa-License-Authority\issuer-private.dpapi
```

The script uses this existing key and never automatically creates or replaces
it. An optional `-AdminDirectory "C:\Existing authority"` selects another
existing key store; it still has to match the public authority trusted by this
project's installers.

For recovery on another administrator PC, follow the encrypted-backup restore
steps in [the offline approval guide](docs/approved-pcs.md#administrator-key-and-backup).

## Common problems

| Message                        | What to do                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Node.js is required            | Install Node.js 22.12 or newer and reopen PowerShell.                          |
| No existing signing key        | Use the original administrator PC/account or restore its encrypted key backup. |
| Request file not found         | Check the path and make sure it ends in `.nawa-request`.                       |
| Output already exists          | Choose another `.nawa-license` filename using `-OutputPath`.                   |
| Expiry must be in the future   | Enter a future date, or omit expiry.                                           |
| Software key requires approval | Review the request, then explicitly add `-AllowSoftwareKey` if acceptable.     |
| Key does not match this build  | Use the authority that signed approvals for this project's public key.         |

Full deployment, device-binding, and offline-revocation details are in
[docs/approved-pcs.md](docs/approved-pcs.md).
