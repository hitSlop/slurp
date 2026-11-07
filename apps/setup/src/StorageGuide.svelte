<script>
import catalog from '../../../crates/slurp-cli/assets/storage-options.json';
let {standalone=false}=$props();
</script>
<section class="storage-guide" id="storage-guide" aria-label="External storage buying guide">
<details open={standalone}>
<summary>{standalone?'Storage options':'Need a drive? Compare storage options ↗'}</summary>
<div class="guide-intro"><p class="eyebrow">Your data. Your choice.</p><h2>Room for your event history.</h2><p>Event histories can grow substantially. An external SSD keeps large or long-lived histories off your internal disk. Your internal disk is fine to start.</p><p class="small">Each project has one <code>events.duckdb</code> file. One drive can hold several folders in <code>SlurpLibrary/</code>. Leave free space for sync and queries; actual storage depends on your events.</p></div>
<ol class="drive-options">
{#each catalog.options as option}
<li><div class="tier"><span>{option.tier}</span><strong>{option.price_range}</strong></div><div class="drive-detail"><h3>{option.model} <span>· {option.capacity}</span></h3><p>{option.description}</p><p class="reference">{option.drive_type} · Reference price: US${option.reference_price.toFixed(2)}</p><div class="drive-links"><a href={option.price_url} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Check current price ↗</a><a href={option.manufacturer_url} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Manufacturer / global options ↗</a></div></div></li>
{/each}
</ol>
<p class="small price-note">USD reference guide · Reviewed {catalog.reviewed_at}. {catalog.disclaimer}</p>
<p class="return-note">After connecting a drive, return to your terminal and choose <strong>Rescan drives</strong>. You can also continue with your internal disk.</p>
</details>
</section>
<style>
.storage-guide{margin:28px 0}.storage-guide summary{cursor:pointer;font-size:14px;color:var(--blue);padding:12px 0}.guide-intro{padding:24px 0 10px;max-width:720px}.guide-intro h2{margin-bottom:16px}.guide-intro p{font-size:15px}.guide-intro .eyebrow{font-size:11px;margin-bottom:14px}.guide-intro .small{font-size:12px}.drive-options{list-style:none;margin:8px 0 20px;padding:0}.drive-options li{display:grid;grid-template-columns:minmax(140px,.65fr) minmax(0,1.6fr);gap:28px;padding:28px 0;border-top:1px solid var(--rule)}.tier{display:flex;flex-direction:column;gap:8px}.tier>span{font-size:12px;color:var(--muted)}.tier strong{font-size:18px;font-weight:600;color:var(--ink)}.drive-detail h3{margin:0 0 10px;font-size:16px}.drive-detail h3 span{font-weight:400;color:var(--muted)}.drive-detail p{font-size:13px;margin-bottom:12px}.drive-detail .reference{font-size:11px}.drive-links{display:flex;flex-wrap:wrap;gap:10px 22px}.drive-links a{font-size:12px;color:var(--blue);padding:4px 0}.price-note,.return-note{font-size:12px;line-height:1.7}.return-note{padding-top:16px;border-top:1px solid var(--rule)}@media(max-width:600px){.drive-options li{grid-template-columns:1fr;gap:16px}.tier{flex-direction:row;align-items:baseline;flex-wrap:wrap;gap:8px 16px}}
</style>
