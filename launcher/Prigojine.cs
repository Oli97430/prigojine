// Lanceur portable de Prigojine : démarre le serveur (Node.js embarqué) sans fenêtre,
// ouvre l'interface dans le navigateur et place une icône près de l'horloge.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

static class Prigojine
{
	const int PORT = 4717;
	static readonly string Url = "http://localhost:" + PORT;
	static string Base = AppDomain.CurrentDomain.BaseDirectory;
	static Process server;
	static NotifyIcon tray;
	static StreamWriter log;
	static bool quitting;

	// /background : lancement à l'ouverture de session Windows, sans ouvrir le navigateur
	static bool background;

	[STAThread]
	static void Main(string[] args)
	{
		background = Array.Exists(args, a => a.Equals("/background", StringComparison.OrdinalIgnoreCase));
		bool first;
		using (var mutex = new Mutex(true, "Prigojine-portable-4717", out first))
		{
			if (!first || Responds()) { if (!background) OpenBrowser(); return; } // déjà lancé : on ouvre simplement la page
			Application.EnableVisualStyles();
			try { StartServer(); }
			catch (Exception e) { MessageBox.Show("Impossible de démarrer Prigojine :\n" + e.Message, "Prigojine", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
			SetupTray();
			new Thread(() =>
			{
				for (int i = 0; i < 60 && !Responds(); i++) Thread.Sleep(500);
				if (Responds()) { if (!background) OpenBrowser(); PollNotes(); }
				else Notify("Le serveur ne répond pas. Voir le journal (clic droit sur l'icône).", ToolTipIcon.Error);
			}) { IsBackground = true }.Start();
			Application.Run();
		}
	}

	static void StartServer()
	{
		string node = Path.Combine(Base, "runtime", "node.exe");
		string app = Path.Combine(Base, "app");
		string script = Path.Combine(app, "server.cjs");
		if (!File.Exists(node)) throw new FileNotFoundException("runtime\\node.exe introuvable");
		if (!File.Exists(script)) throw new FileNotFoundException("app\\server.cjs introuvable");

		var psi = new ProcessStartInfo(node, "\"" + script + "\"")
		{
			WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true,
			RedirectStandardOutput = true, RedirectStandardError = true,
		};
		// adb embarqué si le SDK Android n'est pas installé sur ce PC
		string sdk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Android", "Sdk");
		string bundled = Path.Combine(Base, "android");
		if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ANDROID_HOME")) && !Directory.Exists(Path.Combine(sdk, "platform-tools")))
			psi.EnvironmentVariables["ANDROID_HOME"] = bundled;
		// ffmpeg installé par l'installateur (tools\ffmpeg) pour la vidéo fluide
		psi.EnvironmentVariables["PATH"] = Path.Combine(bundled, "platform-tools") + ";" + Path.Combine(Base, "runtime") + ";" + Path.Combine(Base, "tools", "ffmpeg") + ";" + Environment.GetEnvironmentVariable("PATH");
		psi.EnvironmentVariables["PORT"] = PORT.ToString();

		log = new StreamWriter(Path.Combine(Base, "prigojine.log"), false) { AutoFlush = true };
		log.WriteLine("[" + DateTime.Now + "] démarrage de Prigojine");
		server = new Process { StartInfo = psi, EnableRaisingEvents = true };
		server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
		server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
		server.Exited += (s, e) =>
		{
			if (quitting) return;
			Notify("Prigojine s'est arrêté (code " + server.ExitCode + "). Voir le journal.", ToolTipIcon.Error);
		};
		server.Start();
		server.BeginOutputReadLine();
		server.BeginErrorReadLine();
	}

	static void SetupTray()
	{
		Icon icon = SystemIcons.Application;
		try { icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
		var menu = new ContextMenuStrip();
		menu.Items.Add("Ouvrir Prigojine", null, (s, e) => OpenBrowser());
		menu.Items.Add("Journal", null, (s, e) => { try { Process.Start(Path.Combine(Base, "prigojine.log")); } catch { } });
		menu.Items.Add("Dossier des captures", null, (s, e) => { try { Process.Start(Path.Combine(Base, "app", "captures")); } catch { } });
		menu.Items.Add(new ToolStripSeparator());
		menu.Items.Add("Quitter", null, (s, e) => Quit());
		tray = new NotifyIcon { Icon = icon, Text = "Prigojine — " + Url, Visible = true, ContextMenuStrip = menu };
		tray.DoubleClick += (s, e) => OpenBrowser();
		if (!background) Notify("Prigojine démarre… la page va s'ouvrir.", ToolTipIcon.Info);
	}

	static void Quit()
	{
		quitting = true;
		try
		{
			// arrête le serveur et ses processus enfants (un moteur par appareil)
			if (server != null && !server.HasExited)
				Process.Start(new ProcessStartInfo("taskkill", "/PID " + server.Id + " /T /F") { CreateNoWindow = true, UseShellExecute = false }).WaitForExit(5000);
		}
		catch { }
		if (tray != null) tray.Visible = false;
		Application.Exit();
	}

	static bool Responds()
	{
		try
		{
			var req = (HttpWebRequest)WebRequest.Create(Url + "/api/stream-info");
			req.Timeout = 800;
			req.Headers["X-Prigojine-Token"] = Token();
			using (var res = (HttpWebResponse)req.GetResponse()) return res.StatusCode == HttpStatusCode.OK;
		}
		catch { return false; }
	}

	// Notifications du serveur (agent terminé, accord demandé, émulateur planté…) -> bulles Windows
	static void PollNotes()
	{
		var json = new System.Web.Script.Serialization.JavaScriptSerializer();
		long since = -1;
		while (!quitting)
		{
			try
			{
				var req = (HttpWebRequest)WebRequest.Create(Url + "/api/notes?since=" + Math.Max(since, 0));
				req.Timeout = 3000;
				req.Headers["X-Prigojine-Token"] = Token();
				string body;
				using (var res = req.GetResponse()) using (var rd = new StreamReader(res.GetResponseStream(), System.Text.Encoding.UTF8)) body = rd.ReadToEnd();
				var list = json.Deserialize<System.Collections.Generic.List<System.Collections.Generic.Dictionary<string, object>>>(body);
				foreach (var n in list)
				{
					long id = Convert.ToInt64(n["id"]);
					if (since >= 0)
					{
						string kind = Convert.ToString(n["kind"]);
						var icon = kind == "error" ? ToolTipIcon.Error : kind == "warn" || kind == "ask" ? ToolTipIcon.Warning : ToolTipIcon.Info;
						Notify(Convert.ToString(n["title"]) + " — " + Convert.ToString(n["text"]), icon);
						Thread.Sleep(1500); // laisse le temps de lire chaque bulle
					}
					since = Math.Max(since, id);
				}
				if (since < 0) since = 0; // premier tour : on ignore l'historique
			}
			catch { }
			Thread.Sleep(3000);
		}
	}

	// Clé d'accès écrite par le serveur à chaque démarrage (%USERPROFILE%\.prigojine\token-4717)
	static string Token()
	{
		try { return File.ReadAllText(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".prigojine", "token-" + PORT)).Trim(); }
		catch { return ""; }
	}

	// la page reçoit la clé une fois dans l'adresse, puis la garde dans un cookie protégé
	static void OpenBrowser() { try { Process.Start(Url + "/?t=" + Token()); } catch { } }

	static void Notify(string text, ToolTipIcon kind)
	{
		if (tray == null) return;
		if (text.Length > 250) text = text.Substring(0, 250) + "…";
		try { tray.ShowBalloonTip(5000, "Prigojine", text, kind); } catch { }
	}
}
