# Offline approval for a small set of PCs

Windows installers and packaged Nawa 0.11.3+ require a signed offline approval.
No activation server or internet connection is needed. The installer checks
approval before installing app files. The app checks it before opening windows,
starting model services, reading headless AI settings, or exporting documents.
The bundled CLI also checks it. Copying an installed directory does not approve
another PC.

## Approve a PC

For guided PowerShell approval, use [Approve-NawaPC.ps1](../Approve-NawaPC.ps1)
and its [step-by-step instructions](../Approve-NawaPC.md). The direct commands
below remain available.

1. Run the installer on the target PC using the Windows account that will run
   Nawa. Choose **Export device request** and save the `.nawa-request` file.
2. Transfer the request to the approving administrator. On the administrator's
   PC, from this checkout, run:

   ```powershell
   npm run license:admin -- issue --request "C:\Approvals\PC-01.nawa-request" --licensee "Owner / PC-01" --out "C:\Approvals\PC-01.nawa-license"
   ```

   Add `--expires "2027-12-31T23:59:59.000Z"` for optional expiry. Without it,
   approval does not expire. Each PC is manually approved; there is no trial
   or automatic approval.

3. Transfer the `.nawa-license` file back and select **Import license**. Setup
   proceeds after checking the signature, PC identity, and local private key.
   If setup was closed while waiting, run it again to import the license.

Updates and reinstalls reuse existing valid approvals. An app copied to an
unapproved PC shows the approval dialog instead of opening the workspace.

## Administrator key and backup

The public authority is `apps/shell/build/license-authority.json`. Keep it across
future releases so approved PCs continue working. It is safe to commit this
public file; CI needs no private signing key to build installers.

On a new administrator setup, `npm run license:admin -- init` creates a 3072-bit
RSA authority. **Initialization has already been performed for this checkout**
on the development PC. Its private key is at:

```text
%LOCALAPPDATA%\Nawa-License-Authority\issuer-private.dpapi
```

The private key is Windows DPAPI encrypted for the administrator account and
stored outside the project, in a directory restricted to that account and
SYSTEM. It is never packaged. Do not distribute that directory. Initialization
refuses to replace an existing key or silently switch the trusted public key.

Create a portable password-encrypted backup in a safe location:

```powershell
npm run license:admin -- backup --out "E:\Private backups\Nawa-approval-key.pem"
```

The password is prompted without displaying it. Keep the backup and password
separately. A DPAPI file alone cannot be recovered under another Windows account
or after losing that account's DPAPI keys. Restore the encrypted PEM on a
replacement administrator PC with the same public authority using:

```powershell
npm run license:admin -- init --from "E:\Private backups\Nawa-approval-key.pem"
```

`npm run license:admin -- list` shows issued license IDs, labels, hashed device
identities, and expiry dates. Deleting a ledger entry does not revoke a license.

## Device binding and recovery

Requests normally create a non-exportable RSA key through Windows CNG's
**Microsoft Platform Crypto Provider**, backed by the TPM. Approval binds its
public identity and a hash of Windows MachineGuid plus SMBIOS UUID. Startup
opens the local key and signs a fresh challenge. Copying the license alone
cannot supply that private key on another PC.

Activation covers **one PC and Windows account**, matching the existing per-user
installation workflow. Another Windows account needs a separate request. Use
the same account for setup and running Nawa. Clearing the TPM, reinstalling
Windows, changing the motherboard, or deleting the account/key may require a
new approval; app updates do not recreate the key.

If the TPM is unavailable, **Use a software key** requests a non-exportable
Windows software CNG key with the same PC/account checks. Protection is weaker
than TPM storage. The issuer rejects software requests unless the administrator
explicitly adds `--allow-software`. There is no silent fallback. Requests prove
key possession; they are not remote TPM attestation. A request contains the PC
name, public key, and hashed identity, not raw serial numbers or file contents.

Approval is independent of app profiles and `GENOFFICE_USER_DATA`:

```text
%LOCALAPPDATA%\Nawa\Licensing\<authority-id>\activation.nawa-license
```

Normal uninstallation preserves approval and the CNG key. To remove local
approval, delete that exact activation file. A still-valid signed license can
be imported again: offline operation cannot instantly revoke a remote PC. Use
expiry and periodic renewal when needed. Expiry trusts the PC clock; it is not
an online time or anti-rollback service. Running apps check again next launch.

## Silent deployment

```powershell
# Collect a request and exit without installing.
$p = Start-Process .\Nawa-Setup-0.11.3.exe -ArgumentList '/S', '/NAWAREQUEST=C:\Approvals\PC-01.nawa-request' -Wait -PassThru
$p.ExitCode

# Import approval and install silently.
$p = Start-Process .\Nawa-Setup-0.11.3.exe -ArgumentList '/S', '/NAWALICENSE=C:\Approvals\PC-01.nawa-license' -Wait -PassThru
$p.ExitCode
```

Quote arguments containing spaces. Add `/NAWASOFTWARE` to request collection
only for a software-key request. A silent install without valid approval exits
3 without opening a dialog. A headless app/CLI request returns a structured
`license_required` error and exits 4. Valid approvals are reused on upgrades.
Add `/NAWAVERIFY` for an approval-only preflight: setup verifies or imports the
license and exits without installing or updating application files.

## Build and protection boundaries

Normal Windows packaging builds the small .NET Framework helper from
`tools/licensing/NawaLicense.cs`. Windows supplies .NET Framework/CNG; no extra
activation runtime download is needed. Builds fail if the public authority is
missing or invalid. Only the public verification key enters the helper. The
app and CLI pin its SHA-256 to detect replacement. Configured release signing
also signs the helper before embedding its hash.

Windows packages enable Electron embedded ASAR integrity and
`OnlyLoadAppFromAsar`. `RunAsNode` stays enabled for the CLI and workers. Production
code signing still requires your Windows signing certificate; local builds
without one are unsigned. Licensing controls normal installation/use, but
cannot make locally administered, unsigned software impossible to modify.
Bundled CLI/document/ML tools remain extractable software, not a remote service.

Source/development runs remain unrestricted. The source remains Apache-2.0.
This gate applies to Windows distribution, not macOS/Linux or the browser app.

Run crypto and real Windows TPM integration checks with:

```powershell
node --test tools/licensing/authority.test.cjs tools/licensing/native.test.cjs
```

Native tests use a separate ephemeral authority and remove only their own
activation/CNG keys. They never read the administrator's real private key.
