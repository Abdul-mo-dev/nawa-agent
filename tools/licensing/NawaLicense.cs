// Windows inbox .NET Framework helper. Public authority constants are generated
// at packaging time; no administrator/private signing key enters this executable.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Management;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class NawaLicense
{
    private const int MaxFile = 32768;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxFile, RecursionLimit = 12 };
    private static string Language = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName;
    private static string LicenseDirectory { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nawa", "Licensing", Authority.Id); } }
    private static string LicenseFile { get { return Path.Combine(LicenseDirectory, "activation.nawa-license"); } }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string lang = Option(args, "--lang");
            if (lang != null) Language = lang;
            if (args.Length == 0) throw new InvalidOperationException("Use status, request --out FILE, import --license FILE, or activate.");
            string command = args[0];
            if (command == "installer") return Installer(args);
            if (command == "activate") return Activate();
            if (command == "request")
            {
                string output = Required(args, "--out");
                WriteNew(output, CreateRequest(Array.IndexOf(args, "--software") >= 0));
                Print(new { ok = true, authorityId = Authority.Id, requestFile = Path.GetFullPath(output) });
                return 0;
            }
            if (command == "import")
            {
                ImportLicense(Required(args, "--license"));
                Print(Status());
                return 0;
            }
            if (command == "status") { Print(Status()); return 0; }
            throw new InvalidOperationException("Unknown activation command.");
        }
        catch (Exception error)
        {
            Print(new { ok = false, error = "license_required", message = error.Message, authorityId = Authority.Id });
            return 3;
        }
    }

    private static void Print(object value) { Console.Out.WriteLine(Json.Serialize(value)); }
    private static string InstallerOption(string[] args, string name)
    {
        string result = null;
        foreach (string arg in args)
        {
            if (!arg.StartsWith(name + "=", StringComparison.OrdinalIgnoreCase)) continue;
            if (result != null) throw new InvalidOperationException("Duplicate installer approval option.");
            result = arg.Substring(name.Length + 1);
            if (String.IsNullOrWhiteSpace(result)) throw new InvalidOperationException("Missing installer approval path.");
        }
        return result;
    }
    private static bool InstallerFlag(string[] args, string name)
    {
        foreach (string arg in args) if (String.Equals(arg, name, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
    private static int Installer(string[] args)
    {
        // Let Windows/.NET parse quoting once. NSIS forwards its original argv
        // verbatim, including paths whose entire /OPTION=value token is quoted.
        string request = InstallerOption(args, "/NAWAREQUEST");
        if (request != null)
        {
            WriteNew(request, CreateRequest(InstallerFlag(args, "/NAWASOFTWARE")));
            return 10; // Successfully handled; installer must exit without installing.
        }
        string license = InstallerOption(args, "/NAWALICENSE");
        if (license != null) ImportLicense(license);
        if (InstallerFlag(args, "/S")) Status();
        else if (Activate() != 0) return 3;
        return InstallerFlag(args, "/NAWAVERIFY") ? 10 : 0;
    }
    private static string Option(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
    private static string Required(string[] args, string name)
    {
        string value = Option(args, name);
        if (String.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("Missing " + name + ".");
        return value;
    }
    private static string Hash(byte[] value)
    {
        using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(value)).Replace("-", "").ToLowerInvariant();
    }
    private static string Hash(string value) { return Hash(Encoding.UTF8.GetBytes(value)); }
    private static string MachineId()
    {
        string guid;
        using (RegistryKey key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
            guid = key == null ? null : key.GetValue("MachineGuid") as string;
        if (String.IsNullOrWhiteSpace(guid)) throw new InvalidOperationException(T("identity"));
        string uuid = null;
        using (ManagementObjectSearcher query = new ManagementObjectSearcher("SELECT UUID FROM Win32_ComputerSystemProduct"))
        {
            query.Options.Timeout = TimeSpan.FromSeconds(5);
            foreach (ManagementObject item in query.Get())
            {
                using (item) uuid = Convert.ToString(item["UUID"], CultureInfo.InvariantCulture);
                break;
            }
        }
        if (String.IsNullOrWhiteSpace(uuid)) throw new InvalidOperationException(T("identity"));
        return Hash("nawa-machine-v1\n" + guid.Trim().ToLowerInvariant() + "\n" + uuid.Trim().ToLowerInvariant());
    }
    private static CngKey DeviceKey(string provider, bool create)
    {
        if (provider != "tpm" && provider != "software") throw new InvalidOperationException(T("invalid"));
        CngProvider storage = provider == "tpm" ? new CngProvider("Microsoft Platform Crypto Provider") : CngProvider.MicrosoftSoftwareKeyStorageProvider;
        string name = "Nawa.OfflineLicense." + Authority.Id + "." + provider + ".v1";
        try
        {
            if (CngKey.Exists(name, storage)) return CngKey.Open(name, storage, CngKeyOpenOptions.Silent);
            if (!create) throw new InvalidOperationException(T("keyMissing"));
            CngKeyCreationParameters options = new CngKeyCreationParameters {
                Provider = storage, ExportPolicy = CngExportPolicies.None, KeyUsage = CngKeyUsages.Signing,
                UIPolicy = new CngUIPolicy(CngUIProtectionLevels.None)
            };
            options.Parameters.Add(new CngProperty("Length", BitConverter.GetBytes(2048), CngPropertyOptions.None));
            return CngKey.Create(CngAlgorithm.Rsa, name, options);
        }
        catch (CryptographicException)
        {
            throw new InvalidOperationException(provider == "tpm" ? T("tpmUnavailable") : T("keyMissing"));
        }
    }
    private static Dictionary<string, object> PublicKey(RSACng rsa)
    {
        RSAParameters parameters = rsa.ExportParameters(false);
        return new Dictionary<string, object> {
            { "modulus", Convert.ToBase64String(parameters.Modulus) },
            { "exponent", Convert.ToBase64String(parameters.Exponent) }
        };
    }
    private static string DeviceId(Dictionary<string, object> publicKey) { return Hash((string)publicKey["modulus"] + "." + (string)publicKey["exponent"]); }
    private static string CreateRequest(bool software)
    {
        string provider = software ? "software" : "tpm";
        string machineId = MachineId();
        using (CngKey key = DeviceKey(provider, true))
        using (RSACng rsa = new RSACng(key))
        {
            Dictionary<string, object> publicKey = PublicKey(rsa);
            var payload = new Dictionary<string, object> {
                { "schema", 1 }, { "product", "nawa" }, { "authorityId", Authority.Id },
                { "deviceId", DeviceId(publicKey) }, { "machineId", machineId },
                { "machineName", Environment.MachineName }, { "provider", provider }, { "publicKey", publicKey },
                { "createdAt", DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) }
            };
            byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(payload));
            byte[] signature = rsa.SignData(bytes, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            return Json.Serialize(new { payload = Convert.ToBase64String(bytes), signature = Convert.ToBase64String(signature) });
        }
    }
    private static string ReadLimited(string file)
    {
        if (!File.Exists(file)) throw new InvalidOperationException(T("missing"));
        if (new FileInfo(file).Length > MaxFile) throw new InvalidOperationException(T("invalid"));
        return File.ReadAllText(file, Encoding.UTF8);
    }
    private static Dictionary<string, object> ObjectValue(string value)
    {
        var result = Json.DeserializeObject(value) as Dictionary<string, object>;
        if (result == null) throw new InvalidOperationException(T("invalid"));
        return result;
    }
    private static string Text(Dictionary<string, object> obj, string key)
    {
        object value;
        if (!obj.TryGetValue(key, out value) || !(value is string)) throw new InvalidOperationException(T("invalid"));
        return (string)value;
    }
    private static DateTimeOffset Date(string value)
    {
        DateTimeOffset result;
        if (!DateTimeOffset.TryParseExact(value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out result)) throw new InvalidOperationException(T("invalid"));
        return result;
    }
    private static Dictionary<string, object> Validate(string content)
    {
        Dictionary<string, object> envelope = ObjectValue(content);
        if (envelope.Count != 2) throw new InvalidOperationException(T("invalid"));
        byte[] bytes = Convert.FromBase64String(Text(envelope, "payload"));
        byte[] signature = Convert.FromBase64String(Text(envelope, "signature"));
        using (RSACng issuer = new RSACng())
        {
            issuer.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(Authority.Modulus), Exponent = Convert.FromBase64String(Authority.Exponent) });
            if (!issuer.VerifyData(bytes, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pss)) throw new InvalidOperationException(T("invalid"));
        }
        Dictionary<string, object> payload = ObjectValue(new UTF8Encoding(false, true).GetString(bytes));
        if (payload.Count != 10 || !payload.ContainsKey("schema") || !(payload["schema"] is int) || (int)payload["schema"] != 1 ||
            Text(payload, "product") != "nawa" || Text(payload, "authorityId") != Authority.Id ||
            Text(payload, "licensee").Length < 1 || Text(payload, "licensee").Length > 200) throw new InvalidOperationException(T("invalid"));
        Guid licenseId;
        if (!Guid.TryParseExact(Text(payload, "licenseId"), "D", out licenseId)) throw new InvalidOperationException(T("invalid"));
        DateTimeOffset issued = Date(Text(payload, "issuedAt"));
        if (issued > DateTimeOffset.UtcNow.AddMinutes(5)) throw new InvalidOperationException(T("clock"));
        if (!payload.ContainsKey("expiresAt")) throw new InvalidOperationException(T("invalid"));
        if (payload["expiresAt"] != null)
        {
            DateTimeOffset expires = Date(Text(payload, "expiresAt"));
            if (expires <= issued || expires <= DateTimeOffset.UtcNow) throw new InvalidOperationException(T("expired"));
        }
        if (Text(payload, "machineId") != MachineId()) throw new InvalidOperationException(T("wrongPc"));
        using (CngKey key = DeviceKey(Text(payload, "provider"), false))
        using (RSACng rsa = new RSACng(key))
        {
            if (key.ExportPolicy != CngExportPolicies.None || DeviceId(PublicKey(rsa)) != Text(payload, "deviceId")) throw new InvalidOperationException(T("wrongPc"));
            byte[] challenge = new byte[32];
            using (RandomNumberGenerator random = RandomNumberGenerator.Create()) random.GetBytes(challenge);
            byte[] proof = rsa.SignData(challenge, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            using (RSACng verifier = new RSACng())
            {
                verifier.ImportParameters(rsa.ExportParameters(false));
                if (!verifier.VerifyData(challenge, proof, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1)) throw new InvalidOperationException(T("wrongPc"));
            }
        }
        return payload;
    }
    private static object Status()
    {
        Dictionary<string, object> payload = Validate(ReadLimited(LicenseFile));
        return new { ok = true, authorityId = Authority.Id, licenseId = payload["licenseId"], licensee = payload["licensee"], provider = payload["provider"], expiresAt = payload["expiresAt"] };
    }
    private static void WriteNew(string file, string content)
    {
        using (FileStream stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            byte[] bytes = Encoding.UTF8.GetBytes(content);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
    }
    private static void ImportLicense(string file)
    {
        string content = ReadLimited(file);
        Validate(content);
        Directory.CreateDirectory(LicenseDirectory);
        string temporary = Path.Combine(LicenseDirectory, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            WriteNew(temporary, content);
            if (File.Exists(LicenseFile)) File.Replace(temporary, LicenseFile, null);
            else File.Move(temporary, LicenseFile);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static int Activate()
    {
        try { Status(); return 0; } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (Form form = new Form())
        {
            form.Text = T("title");
            form.ClientSize = new Size(620, 370);
            form.MinimumSize = new Size(580, 400);
            form.StartPosition = FormStartPosition.CenterScreen;
            form.AutoScaleMode = AutoScaleMode.Dpi;
            form.Font = new Font("Segoe UI", 10);
            form.MaximizeBox = false;
            Label intro = new Label { Text = T("intro"), AutoSize = false, Location = new Point(24, 22), Size = new Size(570, 92), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
            Label state = new Label { Text = T("missing"), AutoSize = false, Location = new Point(24, 116), Size = new Size(570, 80), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
            CheckBox software = new CheckBox { Text = T("software"), Location = new Point(24, 210), Size = new Size(570, 44), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top };
            Button export = new Button { Text = T("export"), Location = new Point(24, 278), Size = new Size(180, 40), Anchor = AnchorStyles.Left | AnchorStyles.Bottom };
            Button import = new Button { Text = T("import"), Location = new Point(214, 278), Size = new Size(180, 40), Anchor = AnchorStyles.Left | AnchorStyles.Bottom };
            Button cancel = new Button { Text = T("cancel"), Location = new Point(414, 278), Size = new Size(180, 40), Anchor = AnchorStyles.Right | AnchorStyles.Bottom, DialogResult = DialogResult.Cancel };
            Label account = new Label { Text = T("account"), Location = new Point(24, 334), Size = new Size(570, 28), Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom };
            if (Language == "ar") { intro.RightToLeft = state.RightToLeft = account.RightToLeft = software.RightToLeft = RightToLeft.Yes; }
            export.Click += delegate {
                using (SaveFileDialog picker = new SaveFileDialog { Filter = "Nawa device request (*.nawa-request)|*.nawa-request", FileName = Environment.MachineName + ".nawa-request", OverwritePrompt = false })
                {
                    if (picker.ShowDialog(form) != DialogResult.OK) return;
                    try { WriteNew(picker.FileName, CreateRequest(software.Checked)); state.Text = T("exported"); }
                    catch (Exception error) { state.Text = error.Message; }
                }
            };
            import.Click += delegate {
                using (OpenFileDialog picker = new OpenFileDialog { Filter = "Nawa license (*.nawa-license)|*.nawa-license", CheckFileExists = true })
                {
                    if (picker.ShowDialog(form) != DialogResult.OK) return;
                    try { ImportLicense(picker.FileName); form.DialogResult = DialogResult.OK; form.Close(); }
                    catch (Exception error) { state.Text = error.Message; }
                }
            };
            form.Controls.AddRange(new Control[] { intro, state, software, export, import, cancel, account });
            form.CancelButton = cancel;
            if (form.ShowDialog() != DialogResult.OK) return 3;
        }
        Status();
        return 0;
    }
    private static string T(string key)
    {
        string[] values;
        switch (key)
        {
            case "title": values = new[] { "Nawa — PC approval", "ناوا — اعتماد الكمبيوتر", "Nawa — PC の承認" }; break;
            case "intro": values = new[] { "This PC needs administrator approval before Nawa can be installed or opened.\n1. Export a device request and send it to your administrator.\n2. Import the signed license returned for this PC.", "يلزم اعتماد هذا الكمبيوتر قبل تثبيت ناوا أو فتحه.\n١. صدّر طلب الجهاز وأرسله إلى المسؤول.\n٢. استورد الترخيص الموقّع الذي يعيده المسؤول لهذا الكمبيوتر.", "Nawa のインストールと起動には、この PC の承認が必要です。\n1. デバイス要求を保存し、管理者に送ってください。\n2. この PC 用に発行された署名済みライセンスを読み込んでください。" }; break;
            case "missing": values = new[] { "No valid approval is installed for this PC and Windows account.", "لا يوجد اعتماد صالح لهذا الكمبيوتر وحساب Windows.", "この PC と Windows アカウントの有効な承認がありません。" }; break;
            case "export": values = new[] { "Export device request", "تصدير طلب الجهاز", "デバイス要求を保存" }; break;
            case "import": values = new[] { "Import license", "استيراد الترخيص", "ライセンスを読み込む" }; break;
            case "cancel": values = new[] { "Cancel", "إلغاء", "キャンセル" }; break;
            case "account": values = new[] { "Use the same Windows account for setup and for running Nawa.", "استخدم حساب Windows نفسه للتثبيت وتشغيل ناوا.", "セットアップと Nawa の実行には同じ Windows アカウントを使用してください。" }; break;
            case "software": values = new[] { "Use a software key if TPM is unavailable (requires explicit administrator approval).", "استخدام مفتاح برمجي عند تعذّر TPM (يتطلب اعتمادًا صريحًا من المسؤول).", "TPM を利用できない場合はソフトウェア鍵を使用（管理者の明示的な承認が必要）。" }; break;
            case "exported": values = new[] { "Request saved. Send it to your administrator, then import the returned license.", "تم حفظ الطلب. أرسله إلى المسؤول، ثم استورد الترخيص الذي يعيده.", "要求を保存しました。管理者に送り、発行されたライセンスを読み込んでください。" }; break;
            case "invalid": values = new[] { "The license is invalid or was signed by another authority.", "الترخيص غير صالح أو موقّع من جهة أخرى.", "ライセンスが無効か、別の管理者が署名しています。" }; break;
            case "wrongPc": values = new[] { "This license belongs to another PC or Windows account. Export a new request.", "هذا الترخيص يخص كمبيوتر آخر أو حساب Windows آخر. صدّر طلبًا جديدًا.", "別の PC または Windows アカウント用のライセンスです。新しい要求を保存してください。" }; break;
            case "expired": values = new[] { "This license has expired. Ask your administrator for a replacement.", "انتهت صلاحية الترخيص. اطلب ترخيصًا جديدًا من المسؤول.", "ライセンスの有効期限が切れています。管理者に再発行を依頼してください。" }; break;
            case "clock": values = new[] { "Check the PC date and time. The license issue date is in the future.", "تحقق من تاريخ الكمبيوتر ووقته. تاريخ إصدار الترخيص في المستقبل.", "PC の日時を確認してください。ライセンスの発行日時が未来になっています。" }; break;
            case "identity": values = new[] { "Windows could not read this PC's identity. Check the WMI service and try again.", "تعذّر على Windows قراءة هوية الكمبيوتر. تحقق من خدمة WMI وأعد المحاولة.", "PC の識別情報を取得できません。WMI サービスを確認して再試行してください。" }; break;
            case "keyMissing": values = new[] { "The device key is missing or inaccessible. Use the original Windows account or export a new request.", "مفتاح الجهاز مفقود أو يتعذّر الوصول إليه. استخدم حساب Windows الأصلي أو صدّر طلبًا جديدًا.", "デバイス鍵が見つからないか、アクセスできません。元の Windows アカウントを使用するか、新しい要求を保存してください。" }; break;
            default: values = new[] { "TPM is unavailable. Enable it in Windows, or ask your administrator about explicitly approving a software key.", "TPM غير متاح. فعّله في Windows أو اسأل المسؤول عن اعتماد مفتاح برمجي صراحةً.", "TPM を利用できません。Windows で有効にするか、ソフトウェア鍵の承認について管理者に確認してください。" }; break;
        }
        return values[Language == "ar" ? 1 : Language == "ja" ? 2 : 0];
    }
}
