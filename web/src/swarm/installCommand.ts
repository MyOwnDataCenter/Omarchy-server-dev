// The command a guest pastes. A GitHub install is a raw URL. A copy installed from a
// directory on this computer is not: curl rejects it with "No host present". That guest
// downloads the connector from this server instead.
const HTTPS_BASE = /^https:\/\/[^/?#\s]+/i

export function connectorInstallCommand({
	source,
	server,
	ca,
	token,
	allow,
}: {
	source: string
	server: string
	ca: string
	token: string
	allow: string
}): {command: string; uninstall: string} {
	const given = source.trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = server.replace(/\/+$/, '')
	const src = remote ? given : `${origin}/api/connector`
	const script = remote ? `${src}/main/connector/install.sh` : `${src}/install.sh`
	const curl = remote ? 'curl -fsSL' : 'curl -fsSLk'
	const list = allow ? ` --allow ${allow}` : ''
	return {
		command: `${curl} ${script} | bash -s -- --server ${server} --ca ${ca} --token ${token}${list} --source ${src}`,
		uninstall: `${curl} ${script} | bash -s -- --uninstall`,
	}
}

// The same for Windows, pasted into PowerShell. Like curl -k above, fetching the installer from
// this server skips the certificate check; the installer then checks the server certificate
// against the fingerprint in the command before it trusts anything else.
export function connectorInstallCommandWindows({
	source,
	server,
	ca,
	token,
	allow,
}: {
	source: string
	server: string
	ca: string
	token: string
	allow: string
}): {command: string; uninstall: string} {
	const given = source.trim().replace(/\/+$/, '')
	const remote = HTTPS_BASE.test(given)
	const origin = server.replace(/\/+$/, '')
	const src = remote ? given : `${origin}/api/connector`
	const script = remote ? `${src}/main/connector/install.ps1` : `${src}/install.ps1`
	const fetch = remote
		? `$s = irm '${script}'`
		: `$s = if ($PSVersionTable.PSVersion.Major -ge 6) { irm -SkipCertificateCheck '${script}' } else { [Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}; try { irm '${script}' } finally { [Net.ServicePointManager]::ServerCertificateValidationCallback = $null } }`
	const list = allow ? ` -Allow '${allow}'` : ''
	return {
		command: `${fetch}; & ([scriptblock]::Create($s)) -Server '${server}' -Ca '${ca}' -Token '${token}'${list} -Source '${src}'`,
		uninstall: `${fetch}; & ([scriptblock]::Create($s)) -Uninstall`,
	}
}
