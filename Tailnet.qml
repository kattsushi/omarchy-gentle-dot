import QtQuick
import Quickshell
import Quickshell.Io

// The devices of this machine's tailnet, read from `tailscale status --json`.
// `available` stays false when the tailscale CLI is missing, fails, or prints
// something that is not a status document; the settings view then only offers
// the free-form host field.
Item {
  id: tailnet

  property bool available: false
  property bool loading: false
  // [{ hostName, dnsName, ip, os, online }], online devices first.
  property var peers: []

  function refresh() {
    if (status.running) return
    loading = true
    status.running = true
  }

  function parse(text) {
    var doc
    try {
      doc = JSON.parse(String(text || ""))
    } catch (e) {
      doc = null
    }
    if (!doc || typeof doc !== "object" || !doc.Peer || typeof doc.Peer !== "object") {
      available = false
      peers = []
      return
    }
    var list = []
    for (var key in doc.Peer) {
      var p = doc.Peer[key] || {}
      var dnsName = String(p.DNSName || "").replace(/\.$/, "")
      var ip = Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.length > 0 ? String(p.TailscaleIPs[0]) : ""
      if (!dnsName && !ip) continue
      list.push({
        hostName: String(p.HostName || dnsName || ip),
        dnsName: dnsName,
        ip: ip,
        os: String(p.OS || ""),
        online: p.Online === true
      })
    }
    list.sort(function(a, b) {
      if (a.online !== b.online) return a.online ? -1 : 1
      return a.hostName.toLowerCase() < b.hostName.toLowerCase() ? -1 : (a.hostName.toLowerCase() > b.hostName.toLowerCase() ? 1 : 0)
    })
    peers = list
    available = true
  }

  Process {
    id: status
    command: ["tailscale", "status", "--json"]

    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: tailnet.parse(text)
    }

    onExited: function(exitCode) {
      tailnet.loading = false
      if (exitCode !== 0) {
        tailnet.available = false
        tailnet.peers = []
      }
    }
  }
}
