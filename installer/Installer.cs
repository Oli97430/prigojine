// Installateur de Prigojine.
// - Prigojine est inclus dans l'installateur (ressource « Prigojine-portable.zip »).
// - Les composants Android (SDK platform-tools, émulateur, image Android) sont téléchargés depuis
//   les serveurs officiels de Google, après acceptation de leur licence par l'utilisateur.
// - ffmpeg est téléchargé depuis les builds Windows officielles (gyan.dev).
// Chaque téléchargement est vérifié (SHA-1 Google, SHA-256 ffmpeg).
// Options (tests / installation automatisée) : /silent /dir=<dossier> /skip-android /skip-ffmpeg /skip-avd /no-shortcuts
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Xml;

static class Setup
{
	const string AppName = "Prigojine";
	const string Version = "1.1.1";
	static readonly string LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
	static readonly string Sdk = Path.Combine(LocalAppData, "Android", "Sdk");
	static readonly string AvdHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".android", "avd");
	const string RepoUrl = "https://dl.google.com/android/repository/";
	const string ImgRepoUrl = "https://dl.google.com/android/repository/sys-img/google_apis_playstore/";
	const string FfmpegUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
	static readonly string[] PreferredImages = { "android-36.1", "android-36", "android-35" };

	public class Options
	{
		public string Dir = Path.Combine(LocalAppData, "Programs", AppName);
		public bool App = true, Android = true, Ffmpeg = true, Avds = true, Shortcuts = true, Silent;
	}

	[STAThread]
	static int Main(string[] args)
	{
		ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12 | (SecurityProtocolType)12288; // TLS 1.2 / 1.3
		var o = new Options();
		foreach (var a in args)
		{
			var l = a.ToLowerInvariant();
			if (l == "/silent") o.Silent = true;
			else if (l.StartsWith("/dir=")) o.Dir = a.Substring(5).Trim('"');
			else if (l == "/skip-android") o.Android = false;
			else if (l == "/skip-ffmpeg") o.Ffmpeg = false;
			else if (l == "/skip-avd") o.Avds = false;
			else if (l == "/no-shortcuts") o.Shortcuts = false;
		}
		if (o.Silent)
		{
			// mode automatique : pas de licence Android possible sans interface -> Android exclu
			o.Android = false;
			// journal dans %TEMP%\prigojine-install.log (pas de console en mode fenêtré)
			string logFile = Path.Combine(Path.GetTempPath(), "prigojine-install.log");
			File.WriteAllText(logFile, "");
			Action<string> w = t => File.AppendAllText(logFile, t + "\r\n");
			try { new Installer(o, w, (p, t) => { }).Run(); return 0; }
			catch (Exception e) { w("✕ Échec : " + e.Message); return 1; }
		}
		Application.EnableVisualStyles();
		Application.Run(new Wizard(o));
		return 0;
	}

	/* ======================== Installation ======================== */
	public class Installer
	{
		readonly Options o;
		readonly Action<string> log;
		readonly Action<int, string> progress;
		public Installer(Options o, Action<string> log, Action<int, string> progress) { this.o = o; this.log = log; this.progress = progress; }

		public void Run()
		{
			string tmp = Path.Combine(Path.GetTempPath(), "prigojine-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
			Directory.CreateDirectory(tmp);
			try
			{
				if (o.App) InstallApp();
				if (o.Ffmpeg) InstallFfmpeg(tmp);
				string image = null;
				if (o.Android) image = InstallAndroid(tmp);
				if (o.Avds) CreateAvds(image ?? FindInstalledImage());
				if (o.Shortcuts) CreateShortcuts();
				progress(100, "Terminé");
				log("✔ Installation terminée.");
			}
			finally { try { Directory.Delete(tmp, true); } catch { } }
		}

		void InstallApp()
		{
			progress(2, "Installation de Prigojine…");
			foreach (var p in Process.GetProcesses())
			{
				try { if (p.MainModule.FileName.StartsWith(o.Dir, StringComparison.OrdinalIgnoreCase)) throw new Exception("Prigojine est ouvert : quitte-le (icône près de l'horloge → Quitter) puis relance l'installation."); }
				catch (System.ComponentModel.Win32Exception) { }
				catch (InvalidOperationException) { }
			}
			// on garde les données de l'utilisateur lors d'une mise à jour
			string[] keep = { "prigojine.log", @"app\captures", @"app\macros.json", @"app\settings.json" };
			string save = Path.Combine(Path.GetTempPath(), "prigojine-keep-" + Guid.NewGuid().ToString("N").Substring(0, 8));
			foreach (var k in keep) Copy(Path.Combine(o.Dir, k), Path.Combine(save, k));
			if (Directory.Exists(Path.Combine(o.Dir, "app"))) Directory.Delete(Path.Combine(o.Dir, "app"), true);
			Directory.CreateDirectory(o.Dir);
			using (var res = typeof(Setup).Assembly.GetManifestResourceStream("Prigojine-portable.zip"))
			using (var zip = new ZipArchive(res, ZipArchiveMode.Read))
			{
				foreach (var e in zip.Entries)
				{
					string rel = e.FullName.Replace('\\', '/');
					int cut = rel.IndexOf('/');
					if (cut < 0) continue;
					rel = rel.Substring(cut + 1); // retire « Prigojine/ »
					if (rel.Length == 0) continue;
					string dest = Path.GetFullPath(Path.Combine(o.Dir, rel));
					if (!dest.StartsWith(Path.GetFullPath(o.Dir), StringComparison.OrdinalIgnoreCase)) continue;
					if (rel.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
					Directory.CreateDirectory(Path.GetDirectoryName(dest));
					e.ExtractToFile(dest, true);
				}
			}
			foreach (var k in keep) Copy(Path.Combine(save, k), Path.Combine(o.Dir, k));
			try { Directory.Delete(save, true); } catch { }
			WriteUninstaller();
			log("✔ Prigojine installé dans " + o.Dir);
		}

		void InstallFfmpeg(string tmp)
		{
			string dest = Path.Combine(o.Dir, "tools", "ffmpeg");
			if (File.Exists(Path.Combine(dest, "ffmpeg.exe")) || OnPath("ffmpeg.exe")) { log("• ffmpeg déjà présent : ignoré."); return; }
			progress(8, "Téléchargement de ffmpeg…");
			string zipPath = Path.Combine(tmp, "ffmpeg.zip");
			Download(FfmpegUrl, zipPath, 8, 15, "ffmpeg");
			string expected = Web().DownloadString(FfmpegUrl + ".sha256").Trim().Split(' ')[0].ToLowerInvariant();
			if (Hash(zipPath, SHA256.Create()) != expected) throw new Exception("ffmpeg : somme de contrôle incorrecte, téléchargement corrompu.");
			Directory.CreateDirectory(dest);
			using (var zip = ZipFile.OpenRead(zipPath))
			{
				foreach (var e in zip.Entries)
				{
					string n = e.FullName.Replace('\\', '/');
					if (n.EndsWith("/bin/ffmpeg.exe")) e.ExtractToFile(Path.Combine(dest, "ffmpeg.exe"), true);
					else if (n.EndsWith("/LICENSE") || n.EndsWith("/README.txt")) e.ExtractToFile(Path.Combine(dest, Path.GetFileName(n)), true);
				}
			}
			File.WriteAllText(Path.Combine(dest, "SOURCE.txt"), "ffmpeg (build « essentials » de gyan.dev) — https://www.gyan.dev/ffmpeg/builds/\r\nLicence : GPL v3, voir LICENSE. Code source : https://ffmpeg.org/download.html\r\n");
			log("✔ ffmpeg installé (vidéo fluide).");
		}

		string InstallAndroid(string tmp)
		{
			bool hasTools = File.Exists(Path.Combine(Sdk, "platform-tools", "adb.exe"));
			bool hasEmu = File.Exists(Path.Combine(Sdk, "emulator", "emulator.exe"));
			string existing = FindInstalledImage();
			if (hasTools && hasEmu && existing != null) { log("• Composants Android déjà présents : ignorés."); return existing; }
			progress(16, "Lecture du catalogue Android…");
			var repo = new XmlDocument(); repo.LoadXml(Web().DownloadString(RepoUrl + "repository2-3.xml"));
			Directory.CreateDirectory(Sdk);
			if (!hasTools) { var p = Pick(repo, x => x == "platform-tools"); Fetch(RepoUrl, p, tmp, Sdk, 18, 22, "platform-tools"); }
			if (!hasEmu) { var p = Pick(repo, x => x == "emulator"); Fetch(RepoUrl, p, tmp, Sdk, 22, 40, "émulateur Android"); }
			if (existing == null)
			{
				var img = new XmlDocument(); img.LoadXml(Web().DownloadString(ImgRepoUrl + "sys-img2-3.xml"));
				Pkg best = null;
				foreach (var api in PreferredImages) { best = TryPick(img, x => x == "system-images;" + api + ";google_apis_playstore;x86_64"); if (best != null) break; }
				if (best == null) throw new Exception("Aucune image Android compatible trouvée dans le catalogue de Google.");
				string api2 = best.Path.Split(';')[1];
				string parent = Path.Combine(Sdk, "system-images", api2, "google_apis_playstore");
				Fetch(ImgRepoUrl, best, tmp, parent, 40, 92, "image Android " + api2.Replace("android-", ""));
				existing = api2;
			}
			log("✔ Composants Android installés dans " + Sdk);
			return existing;
		}

		// Émulateurs légers prêts à l'emploi (téléphone + tablette), sans écraser l'existant
		void CreateAvds(string api)
		{
			if (api == null) { log("• Pas d'image Android : émulateurs non créés."); return; }
			progress(94, "Création des émulateurs…");
			Directory.CreateDirectory(AvdHome);
			CreateAvd("Prigojine_Telephone", "Prigojine Téléphone (720x1600)", 720, 1600, 280, "portrait", "medium_phone", api);
			CreateAvd("Prigojine_Tablette", "Prigojine Tablette (1280x800)", 1280, 800, 160, "landscape", "medium_tablet", api);
			// Vulkan désactivé : évite les plantages de l'émulateur avec certains pilotes graphiques
			string adv = Path.Combine(Path.GetDirectoryName(AvdHome), "advancedFeatures.ini");
			if (!File.Exists(adv)) File.WriteAllText(adv, "Vulkan = off\r\nGLDirectMem = on\r\n");
		}

		void CreateAvd(string id, string name, int w, int h, int dpi, string orient, string device, string api)
		{
			string dir = Path.Combine(AvdHome, id + ".avd");
			if (Directory.Exists(dir)) { log("• Émulateur " + id + " déjà présent."); return; }
			Directory.CreateDirectory(dir);
			var c = new StringBuilder();
			Action<string, object> k = (key, v) => c.Append(key).Append('=').Append(v).Append("\r\n");
			k("AvdId", id); k("avd.ini.displayname", name); k("avd.ini.encoding", "UTF-8");
			k("PlayStore.enabled", "true"); k("abi.type", "x86_64"); k("hw.cpu.arch", "x86_64");
			k("image.sysdir.1", @"system-images\" + api + @"\google_apis_playstore\x86_64\"); k("target", api);
			k("tag.id", "google_apis_playstore"); k("tag.ids", "google_apis_playstore"); k("tag.display", "Google Play"); k("tag.displaynames", "Google Play");
			k("hw.device.name", device); k("hw.device.manufacturer", "Generic");
			k("hw.lcd.width", w); k("hw.lcd.height", h); k("hw.lcd.density", dpi); k("hw.initialOrientation", orient);
			k("skin.name", w + "x" + h); k("skin.path", "_no_skin"); k("skin.dynamic", "yes"); k("showDeviceFrame", "no");
			k("hw.ramSize", 2048); k("hw.cpu.ncore", 2); k("vm.heapSize", 192); k("disk.dataPartition.size", "3G"); k("sdcard.size", "512M"); k("hw.sdCard", "yes");
			k("hw.gpu.enabled", "yes"); k("hw.gpu.mode", "auto"); k("hw.keyboard", "yes");
			k("hw.camera.back", "none"); k("hw.camera.front", "none"); k("hw.audioInput", "no"); k("hw.audioOutput", "no");
			k("hw.accelerometer", "yes"); k("hw.gps", "yes"); k("hw.battery", "yes"); k("hw.mainKeys", "no"); k("hw.dPad", "no"); k("hw.trackBall", "no");
			k("fastboot.forceFastBoot", "yes"); k("fastboot.forceColdBoot", "no");
			File.WriteAllText(Path.Combine(dir, "config.ini"), c.ToString());
			File.WriteAllText(Path.Combine(AvdHome, id + ".ini"), "avd.ini.encoding=UTF-8\r\npath=" + dir + "\r\npath.rel=avd\\" + id + ".avd\r\ntarget=" + api + "\r\n");
			log("✔ Émulateur créé : " + name);
		}

		void CreateShortcuts()
		{
			string exe = Path.Combine(o.Dir, "Prigojine.exe");
			Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Prigojine.lnk"), exe);
			string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Prigojine");
			Directory.CreateDirectory(menu);
			Shortcut(Path.Combine(menu, "Prigojine.lnk"), exe);
			log("✔ Raccourcis créés (Bureau et menu Démarrer).");
		}

		void WriteUninstaller()
		{
			string menu = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Prigojine");
			string desk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Prigojine.lnk");
			string cmd = "@echo off\r\n" +
				"taskkill /IM Prigojine.exe /F >nul 2>&1\r\n" +
				"del \"" + desk + "\" >nul 2>&1\r\n" +
				"rmdir /s /q \"" + menu + "\" >nul 2>&1\r\n" +
				"reg delete \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Prigojine\" /f >nul 2>&1\r\n" +
				"echo Prigojine a ete desinstalle. Les composants Android (SDK, emulateurs) sont conserves.\r\n" +
				"cd /d \"%TEMP%\"\r\n" +
				"(goto) 2>nul & rmdir /s /q \"" + o.Dir + "\"\r\n"; // supprime le dossier, ce script compris
			File.WriteAllText(Path.Combine(o.Dir, "Desinstaller.cmd"), cmd, Encoding.Default);
			using (var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Prigojine"))
			{
				key.SetValue("DisplayName", "Prigojine");
				key.SetValue("DisplayVersion", Version);
				key.SetValue("Publisher", "Oli97430");
				key.SetValue("DisplayIcon", Path.Combine(o.Dir, "Prigojine.exe"));
				key.SetValue("InstallLocation", o.Dir);
				key.SetValue("UninstallString", "cmd.exe /c \"\"" + Path.Combine(o.Dir, "Desinstaller.cmd") + "\"\"");
				key.SetValue("URLInfoAbout", "https://github.com/Oli97430/prigojine");
				key.SetValue("NoModify", 1); key.SetValue("NoRepair", 1);
			}
		}

		/* ----- Outils ----- */
		public class Pkg { public string Path, Url; public long Size; public string Sha1; }

		static Pkg TryPick(XmlDocument doc, Func<string, bool> match)
		{
			var channels = new Dictionary<string, string>();
			foreach (XmlNode c in doc.SelectNodes("//channel")) channels[c.Attributes["id"].Value] = c.InnerText;
			Pkg best = null; int bestRev = -1;
			foreach (XmlNode p in doc.SelectNodes("//remotePackage"))
			{
				string path = p.Attributes["path"].Value;
				if (!match(path)) continue;
				var cref = p.SelectSingleNode("channelRef");
				if (cref != null && channels[cref.Attributes["ref"].Value] != "stable") continue;
				int rev = int.Parse(p.SelectSingleNode("revision/major").InnerText);
				foreach (XmlNode a in p.SelectNodes("archives/archive"))
				{
					var os = a.SelectSingleNode("host-os"); var arch = a.SelectSingleNode("host-arch");
					if (os != null && os.InnerText != "windows") continue;
					if (arch != null && arch.InnerText != "x64" && arch.InnerText != "x86_64") continue;
					if (rev <= bestRev) continue;
					bestRev = rev;
					best = new Pkg { Path = path, Url = a.SelectSingleNode("complete/url").InnerText, Size = long.Parse(a.SelectSingleNode("complete/size").InnerText), Sha1 = a.SelectSingleNode("complete/checksum").InnerText.ToLowerInvariant() };
				}
			}
			return best;
		}
		static Pkg Pick(XmlDocument doc, Func<string, bool> match)
		{
			var p = TryPick(doc, match);
			if (p == null) throw new Exception("Composant introuvable dans le catalogue de Google.");
			return p;
		}

		void Fetch(string baseUrl, Pkg p, string tmp, string extractTo, int from, int to, string label)
		{
			string zipPath = Path.Combine(tmp, System.IO.Path.GetFileName(p.Url));
			log(string.Format("• {0} : {1:N0} Mo à télécharger…", label, p.Size / 1048576.0));
			Download(baseUrl + p.Url, zipPath, from, to - 3, label);
			progress(to - 3, "Vérification de " + label + "…");
			if (Hash(zipPath, SHA1.Create()) != p.Sha1) throw new Exception(label + " : somme de contrôle incorrecte, téléchargement corrompu.");
			progress(to - 2, "Décompression de " + label + "…");
			Directory.CreateDirectory(extractTo);
			using (var zip = ZipFile.OpenRead(zipPath))
			{
				string root = Path.GetFullPath(extractTo);
				foreach (var e in zip.Entries)
				{
					string dest = Path.GetFullPath(Path.Combine(extractTo, e.FullName));
					if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue; // pas de sortie du dossier
					if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(dest); continue; }
					Directory.CreateDirectory(Path.GetDirectoryName(dest));
					e.ExtractToFile(dest, true);
				}
			}
			File.Delete(zipPath);
			log("✔ " + label + " installé.");
		}

		void Download(string url, string dest, int from, int to, string label)
		{
			var req = (HttpWebRequest)WebRequest.Create(url);
			req.UserAgent = "Prigojine-Installer/" + Version;
			req.Timeout = 60000; req.ReadWriteTimeout = 120000;
			using (var res = (HttpWebResponse)req.GetResponse())
			using (var src = res.GetResponseStream())
			using (var dst = File.Create(dest))
			{
				long total = res.ContentLength, done = 0; var buf = new byte[1 << 16]; int n;
				var last = DateTime.MinValue;
				while ((n = src.Read(buf, 0, buf.Length)) > 0)
				{
					dst.Write(buf, 0, n); done += n;
					if ((DateTime.Now - last).TotalMilliseconds > 300)
					{
						last = DateTime.Now;
						int pct = total > 0 ? from + (int)((to - from) * done / total) : from;
						progress(pct, string.Format("Téléchargement de {0} : {1:N0} / {2:N0} Mo", label, done / 1048576.0, total / 1048576.0));
					}
				}
			}
		}

		static string Hash(string file, HashAlgorithm algo)
		{
			using (algo) using (var f = File.OpenRead(file)) return BitConverter.ToString(algo.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
		}

		static bool OnPath(string exe)
		{
			foreach (var d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
				try { if (d.Length > 0 && File.Exists(Path.Combine(d.Trim(), exe))) return true; } catch { }
			return false;
		}

		static void Copy(string src, string dst)
		{
			if (File.Exists(src)) { Directory.CreateDirectory(Path.GetDirectoryName(dst)); File.Copy(src, dst, true); }
			else if (Directory.Exists(src))
			{
				foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
				{
					string t = Path.Combine(dst, f.Substring(src.Length).TrimStart('\\'));
					Directory.CreateDirectory(Path.GetDirectoryName(t)); File.Copy(f, t, true);
				}
			}
		}

		static void Shortcut(string lnk, string target)
		{
			var shellType = Type.GetTypeFromProgID("WScript.Shell");
			dynamic shell = Activator.CreateInstance(shellType);
			dynamic s = shell.CreateShortcut(lnk);
			s.TargetPath = target; s.WorkingDirectory = Path.GetDirectoryName(target); s.IconLocation = target + ",0";
			s.Description = "Pilote tes téléphones et tablettes Android";
			s.Save();
		}
	}

	static WebClient Web() { var w = new WebClient { Encoding = Encoding.UTF8 }; w.Headers["User-Agent"] = "Prigojine-Installer/" + Version; return w; }

	// Image Android déjà installée (la plus récente parmi celles que Prigojine sait utiliser)
	static string FindInstalledImage()
	{
		foreach (var api in PreferredImages)
			if (File.Exists(Path.Combine(Sdk, "system-images", api, "google_apis_playstore", "x86_64", "system.img"))) return api;
		return null;
	}

	// Texte de la licence du SDK Android, lu dans le catalogue officiel de Google
	public static string AndroidLicense()
	{
		var repo = new XmlDocument(); repo.LoadXml(Web().DownloadString(RepoUrl + "repository2-3.xml"));
		var n = repo.SelectSingleNode("//license[@id='android-sdk-license']");
		return n == null ? "(licence introuvable — consulte https://developer.android.com/studio/terms)" : n.InnerText.Trim().Replace("\n", "\r\n");
	}

	/* ======================== Interface ======================== */
	class Wizard : Form
	{
		readonly Options o;
		readonly Panel p1 = new Panel(), p2 = new Panel(), p3 = new Panel();
		readonly TextBox dirBox = new TextBox(), licBox = new TextBox(), logBox = new TextBox();
		readonly CheckBox cAndroid = new CheckBox(), cFfmpeg = new CheckBox(), cAvd = new CheckBox(), cShort = new CheckBox(), cAccept = new CheckBox(), cLaunch = new CheckBox();
		readonly Button next = new Button(), back = new Button();
		readonly ProgressBar bar = new ProgressBar();
		readonly Label step = new Label(), sizeInfo = new Label();
		int page = 1; bool done;

		static readonly Color Bg = Color.FromArgb(22, 24, 27), Fg = Color.FromArgb(236, 231, 221), Amber = Color.FromArgb(255, 178, 62), Dim = Color.FromArgb(150, 146, 138);

		public Wizard(Options o)
		{
			this.o = o;
			Text = "Installation de Prigojine " + Version;
			ClientSize = new Size(640, 470); FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
			BackColor = Bg; ForeColor = Fg; Font = new Font("Segoe UI", 9.5f);
			try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
			var title = new Label { Text = "Prigojine", Font = new Font("Segoe UI Semibold", 20f), ForeColor = Amber, Location = new Point(24, 16), AutoSize = true };
			var sub = new Label { Text = "Pilote tes téléphones et tablettes Android depuis le PC", ForeColor = Dim, Location = new Point(27, 56), AutoSize = true };
			Controls.Add(title); Controls.Add(sub);
			foreach (var p in new[] { p1, p2, p3 }) { p.SetBounds(24, 88, 592, 320); Controls.Add(p); }
			BuildPage1(); BuildPage2(); BuildPage3();
			back.SetBounds(404, 424, 100, 32); back.Text = "Retour"; back.Click += (s, e) => Show(page - 1);
			next.SetBounds(516, 424, 100, 32); next.Text = "Suivant"; next.Click += (s, e) => Next();
			foreach (var b in new[] { back, next }) { b.FlatStyle = FlatStyle.Flat; b.BackColor = Color.FromArgb(40, 43, 48); b.ForeColor = Fg; Controls.Add(b); }
			next.BackColor = Amber; next.ForeColor = Color.Black;
			Show(1);
		}

		CheckBox Opt(Panel p, CheckBox c, string text, int y, bool on)
		{
			c.Text = text; c.Checked = on; c.AutoSize = true; c.Location = new Point(4, y); p.Controls.Add(c); return c;
		}

		void BuildPage1()
		{
			p1.Controls.Add(new Label { Text = "Dossier d'installation :", Location = new Point(0, 0), AutoSize = true });
			dirBox.SetBounds(0, 22, 480, 26); dirBox.Text = o.Dir; p1.Controls.Add(dirBox);
			var browse = new Button { Text = "Parcourir…", FlatStyle = FlatStyle.Flat }; browse.SetBounds(488, 21, 104, 28);
			browse.Click += (s, e) => { using (var d = new FolderBrowserDialog { SelectedPath = dirBox.Text }) if (d.ShowDialog() == DialogResult.OK) dirBox.Text = Path.Combine(d.SelectedPath, "Prigojine"); };
			p1.Controls.Add(browse);
			p1.Controls.Add(new Label { Text = "Composants :", Location = new Point(0, 64), AutoSize = true, ForeColor = Amber });
			bool sdkOk = File.Exists(Path.Combine(Sdk, "emulator", "emulator.exe")) && FindInstalledImage() != null;
			Opt(p1, cAndroid, sdkOk ? "Composants Android — déjà installés" : "Composants Android : SDK, émulateur et image Android 16 (≈ 2,4 Go téléchargés depuis Google)", 88, !sdkOk);
			if (sdkOk) cAndroid.Enabled = false;
			Opt(p1, cFfmpeg, "ffmpeg — vidéo fluide des écrans (≈ 100 Mo depuis gyan.dev)", 116, true);
			Opt(p1, cAvd, "Créer 2 émulateurs légers prêts à l'emploi (un téléphone, une tablette)", 144, true);
			Opt(p1, cShort, "Raccourcis sur le Bureau et dans le menu Démarrer", 172, true);
			sizeInfo.SetBounds(0, 212, 592, 90); sizeInfo.ForeColor = Dim;
			sizeInfo.Text = "Prigojine lui-même est inclus dans cet installateur. Les composants Android et ffmpeg sont téléchargés depuis leurs sites officiels et vérifiés.\r\n\r\nEspace disque nécessaire : environ 5 Go avec les composants Android (dont les émulateurs une fois utilisés), 300 Mo sans.";
			p1.Controls.Add(sizeInfo);
		}

		void BuildPage2()
		{
			p2.Controls.Add(new Label { Text = "Licence du SDK Android (Google) — à lire et accepter pour installer les composants Android :", Location = new Point(0, 0), Size = new Size(592, 20), ForeColor = Amber });
			licBox.Multiline = true; licBox.ReadOnly = true; licBox.ScrollBars = ScrollBars.Vertical; licBox.SetBounds(0, 24, 592, 220);
			licBox.BackColor = Color.FromArgb(14, 15, 17); licBox.ForeColor = Fg; licBox.Font = new Font("Consolas", 8.5f);
			p2.Controls.Add(licBox);
			Opt(p2, cAccept, "J'ai lu et j'accepte les conditions de la licence du SDK Android", 252, false);
			p2.Controls.Add(new Label { Text = "ffmpeg est distribué sous licence GPL v3 (texte installé avec lui).", Location = new Point(0, 284), AutoSize = true, ForeColor = Dim });
		}

		void BuildPage3()
		{
			step.SetBounds(0, 0, 592, 22); p3.Controls.Add(step);
			bar.SetBounds(0, 26, 592, 18); p3.Controls.Add(bar);
			logBox.Multiline = true; logBox.ReadOnly = true; logBox.ScrollBars = ScrollBars.Vertical; logBox.SetBounds(0, 54, 592, 228);
			logBox.BackColor = Color.FromArgb(14, 15, 17); logBox.ForeColor = Fg; logBox.Font = new Font("Consolas", 9f);
			p3.Controls.Add(logBox);
			Opt(p3, cLaunch, "Lancer Prigojine", 292, true); cLaunch.Visible = false;
		}

		void Show(int n)
		{
			page = n;
			p1.Visible = n == 1; p2.Visible = n == 2; p3.Visible = n == 3;
			back.Visible = n == 2; next.Text = n == 1 ? "Suivant" : n == 2 ? "Installer" : done ? "Terminer" : "Patiente…";
			next.Enabled = n != 3 || done;
		}

		void Next()
		{
			if (page == 1)
			{
				o.Dir = dirBox.Text.Trim(); o.Android = cAndroid.Checked && cAndroid.Enabled; o.Ffmpeg = cFfmpeg.Checked; o.Avds = cAvd.Checked; o.Shortcuts = cShort.Checked;
				if (o.Android)
				{
					licBox.Text = "Chargement de la licence depuis Google…"; Show(2);
					new Thread(() => { string t; try { t = AndroidLicense(); } catch (Exception e) { t = "Impossible de charger la licence (" + e.Message + "). Vérifie ta connexion Internet."; } BeginInvoke((Action)(() => licBox.Text = t)); }) { IsBackground = true }.Start();
				}
				else Start();
			}
			else if (page == 2)
			{
				if (!cAccept.Checked) { MessageBox.Show("Coche la case d'acceptation de la licence du SDK Android, ou reviens en arrière et décoche les composants Android.", "Prigojine"); return; }
				Start();
			}
			else if (page == 3 && done)
			{
				if (cLaunch.Checked && cLaunch.Visible) try { Process.Start(Path.Combine(o.Dir, "Prigojine.exe")); } catch { }
				Close();
			}
		}

		void Start()
		{
			Show(3);
			Action<string> log = t => BeginInvoke((Action)(() => logBox.AppendText(t + "\r\n")));
			Action<int, string> prog = (p, t) => BeginInvoke((Action)(() => { bar.Value = Math.Max(0, Math.Min(100, p)); step.Text = t; }));
			new Thread(() =>
			{
				try
				{
					new Installer(o, log, prog).Run();
					BeginInvoke((Action)(() => { done = true; cLaunch.Visible = true; step.Text = "Installation terminée."; Show(3); }));
					CheckHypervisor(log);
				}
				catch (Exception e)
				{
					log("✕ " + e.Message);
					BeginInvoke((Action)(() => { done = true; step.Text = "L'installation a échoué."; next.Text = "Fermer"; next.Enabled = true; }));
				}
			}) { IsBackground = true }.Start();
		}

		// Les émulateurs ont besoin de la « Plateforme de l'hyperviseur Windows »
		void CheckHypervisor(Action<string> log)
		{
			string emu = Path.Combine(Sdk, "emulator", "emulator.exe");
			if (!File.Exists(emu)) return;
			try
			{
				var p = Process.Start(new ProcessStartInfo(emu, "-accel-check") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true });
				string outp = p.StandardOutput.ReadToEnd(); p.WaitForExit(30000);
				if (outp.Contains("usable")) { log("✔ Accélération matérielle disponible pour les émulateurs."); return; }
			}
			catch { }
			log("⚠ La « Plateforme de l'hyperviseur Windows » n'est pas active : les émulateurs seront très lents ou ne démarreront pas.");
			BeginInvoke((Action)(() =>
			{
				if (MessageBox.Show("Les émulateurs Android ont besoin de la « Plateforme de l'hyperviseur Windows ».\n\nL'activer maintenant ? (droits administrateur, puis redémarrage du PC)", "Prigojine", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
				{
					try { Process.Start(new ProcessStartInfo("dism.exe", "/online /enable-feature /featurename:HypervisorPlatform /all /norestart") { Verb = "runas", UseShellExecute = true }); }
					catch { MessageBox.Show("Activation annulée. Tu peux le faire plus tard : Paramètres → Fonctionnalités facultatives → Plus de fonctionnalités Windows → Plateforme de l'hyperviseur Windows.", "Prigojine"); }
				}
			}));
		}
	}
}
