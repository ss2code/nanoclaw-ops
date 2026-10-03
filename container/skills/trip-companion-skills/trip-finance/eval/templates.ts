// HTML/CSS renders of UPI payment-success screens (Paytm / GPay / PhonePe visual
// styles) and thermal-printer bills. Screenshotted headless by generate.ts.
// Approximations of each app's look, parameterized so every fixture differs.

export interface UpiSpec {
  style: 'paytm' | 'gpay' | 'phonepe';
  amountMajor: string; // "1234.56"
  payee: string;
  payerName: string | null; // shown as the sending account where the style supports it
  bank: string;
  txnId: string;
  dateText: string;
}

export interface BillItem {
  name: string;
  qty: number;
  priceMajor: string;
}

export interface BillSpec {
  style: 'bill-itemised' | 'bill-total';
  merchant: string;
  addressLine: string;
  items: BillItem[]; // empty for bill-total
  totalMajor: string;
  gstMajor: string;
  dateText: string;
  billNo: string;
}

const inr = (s: string) => `₹${Number(s).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

const page = (w: number, body: string, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;font-family:-apple-system,'Segoe UI',Roboto,sans-serif}
body{width:${w}px;background:#fff}
${extra}
</style></head><body>${body}</body></html>`;

export function renderUpi(s: UpiSpec): { html: string; width: number; height: number } {
  if (s.style === 'paytm') {
    return {
      width: 420,
      height: 840,
      html: page(
        420,
        `<div class="hdr">paytm</div>
        <div class="card">
          <div class="check">✓</div>
          <div class="ok">Paid Successfully</div>
          <div class="amt">${inr(s.amountMajor)}</div>
          <div class="to">To: <b>${s.payee}</b></div>
          ${s.payerName ? `<div class="from">From: ${s.payerName} · ${s.bank}</div>` : `<div class="from">${s.bank}</div>`}
          <div class="meta">UPI Ref No: ${s.txnId}</div>
          <div class="meta">${s.dateText}</div>
        </div>
        <div class="foot">100% Secure Payments</div>`,
        `.hdr{background:#00baf2;color:#fff;font-weight:800;font-size:26px;padding:18px 22px;font-style:italic}
        .card{margin:26px 18px;border:1px solid #e6e6e6;border-radius:14px;padding:30px 22px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.06)}
        .check{width:64px;height:64px;border-radius:50%;background:#21c179;color:#fff;font-size:38px;line-height:64px;margin:0 auto 14px}
        .ok{color:#21c179;font-weight:700;font-size:19px;margin-bottom:18px}
        .amt{font-size:40px;font-weight:800;color:#182433;margin-bottom:16px}
        .to{font-size:16px;color:#333;margin-bottom:8px}
        .from{font-size:13.5px;color:#777;margin-bottom:20px}
        .meta{font-size:12.5px;color:#999;margin:4px 0}
        .foot{text-align:center;color:#bbb;font-size:12px;margin-top:40px}`,
      ),
    };
  }
  if (s.style === 'gpay') {
    return {
      width: 420,
      height: 840,
      html: page(
        420,
        `<div class="top"><div class="gcheck">✓</div></div>
        <div class="ctr">
          <div class="big">${inr(s.amountMajor)}</div>
          <div class="paidto">Paid to <b>${s.payee}</b></div>
          ${s.payerName ? `<div class="acct">${s.payerName} · ${s.bank} ••6210</div>` : `<div class="acct">${s.bank} ••6210</div>`}
          <div class="when">${s.dateText}</div>
          <div class="upi">UPI transaction ID<br><b>${s.txnId}</b></div>
        </div>`,
        `body{background:#fff}
        .top{padding:70px 0 26px;text-align:center}
        .gcheck{width:88px;height:88px;border-radius:50%;background:#34a853;color:#fff;font-size:52px;line-height:88px;margin:0 auto}
        .ctr{text-align:center;padding:0 26px}
        .big{font-size:44px;font-weight:500;color:#202124;margin-bottom:10px}
        .paidto{font-size:17px;color:#3c4043;margin-bottom:24px}
        .acct{font-size:13.5px;color:#5f6368;margin-bottom:6px}
        .when{font-size:13.5px;color:#5f6368;margin-bottom:34px}
        .upi{font-size:13px;color:#5f6368;line-height:1.7}`,
      ),
    };
  }
  // phonepe
  return {
    width: 420,
    height: 840,
    html: page(
      420,
      `<div class="ph"><div class="pcheck">✓</div>
        <div class="pok">Payment Successful</div>
        <div class="pwhen">${s.dateText}</div></div>
      <div class="pcard">
        <div class="prow"><span class="plab">Paid to</span><span class="pval"><b>${s.payee}</b></span></div>
        <div class="pamt">${inr(s.amountMajor)}</div>
        ${s.payerName ? `<div class="pdebit">Debited from ${s.payerName} · ${s.bank} XX4521</div>` : `<div class="pdebit">Debited from ${s.bank} XX4521</div>`}
        <div class="ptxn">Transaction ID<br><b>${s.txnId}</b></div>
      </div>`,
      `body{background:#5f259f;min-height:840px}
      .ph{text-align:center;padding:60px 20px 30px;color:#fff}
      .pcheck{width:76px;height:76px;border-radius:50%;background:#26b35f;color:#fff;font-size:44px;line-height:76px;margin:0 auto 16px}
      .pok{font-size:21px;font-weight:700}
      .pwhen{font-size:13px;opacity:.8;margin-top:6px}
      .pcard{background:#fff;border-radius:14px;margin:10px 16px;padding:24px 20px}
      .prow{display:flex;justify-content:space-between;font-size:15px;margin-bottom:14px}
      .plab{color:#777}
      .pamt{font-size:38px;font-weight:800;color:#1d1d1d;margin-bottom:14px}
      .pdebit{font-size:13px;color:#666;margin-bottom:18px;border-bottom:1px dashed #ddd;padding-bottom:16px}
      .ptxn{font-size:12.5px;color:#888;line-height:1.7}`,
    ),
  };
}

export function renderBill(s: BillSpec): { html: string; width: number; height: number } {
  const itemRows = s.items
    .map(
      (it) =>
        `<tr><td>${it.name}</td><td class="r">${it.qty}</td><td class="r">${Number(it.priceMajor).toFixed(2)}</td></tr>`,
    )
    .join('');
  const height = 360 + s.items.length * 26;
  return {
    width: 380,
    height,
    html: page(
      380,
      `<div class="paper">
        <div class="shop">${s.merchant}</div>
        <div class="addr">${s.addressLine}</div>
        <div class="dash"></div>
        <div class="row"><span>Bill No: ${s.billNo}</span><span>${s.dateText}</span></div>
        <div class="dash"></div>
        ${
          s.style === 'bill-itemised'
            ? `<table><tr class="hd"><td>ITEM</td><td class="r">QTY</td><td class="r">AMT</td></tr>${itemRows}</table><div class="dash"></div>`
            : ''
        }
        <div class="row"><span>GST (5%)</span><span>${Number(s.gstMajor).toFixed(2)}</span></div>
        <div class="row total"><span>TOTAL</span><span>Rs. ${Number(s.totalMajor).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span></div>
        <div class="dash"></div>
        <div class="thanks">** THANK YOU VISIT AGAIN **</div>
      </div>`,
      `body{background:#d8d8d2;padding:14px}
      .paper{background:#fdfdf8;padding:18px 16px;font-family:'Courier New',monospace;color:#222;box-shadow:1px 2px 6px rgba(0,0,0,.35)}
      .shop{text-align:center;font-weight:700;font-size:17px;letter-spacing:.5px}
      .addr{text-align:center;font-size:11px;color:#444;margin:4px 0 10px}
      .dash{border-top:1px dashed #555;margin:8px 0}
      .row{display:flex;justify-content:space-between;font-size:12.5px;margin:3px 0}
      .total{font-weight:700;font-size:15px;margin-top:6px}
      table{width:100%;font-size:12px;border-collapse:collapse}
      td{padding:2px 0}
      .r{text-align:right}
      .hd td{font-weight:700;border-bottom:1px solid #999}
      .thanks{text-align:center;font-size:11px;margin-top:10px}`,
    ),
  };
}

/** Wrapper page that re-renders a clean PNG with a visual degradation. */
export function renderDegradation(
  pngFileUrl: string,
  width: number,
  height: number,
  kind: 'blur' | 'heavy-blur' | 'lowlight' | 'rotate' | 'crop',
): { html: string; width: number; height: number } {
  const styles: Record<string, string> = {
    blur: 'filter: blur(2.2px);',
    'heavy-blur': 'filter: blur(7px);',
    lowlight: 'filter: brightness(0.42) contrast(0.75);',
    rotate: 'transform: rotate(8deg) scale(0.86); transform-origin: center;',
    crop: '', // handled by shrinking the viewport so the lower half is cut off
  };
  const h = kind === 'crop' ? Math.round(height * 0.52) : height;
  return {
    width,
    height: h,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}body{width:${width}px;height:${h}px;overflow:hidden;background:#222}
img{width:${width}px;height:${height}px;${styles[kind]}}
</style></head><body><img src="${pngFileUrl}"></body></html>`,
  };
}
