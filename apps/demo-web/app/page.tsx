/**
 * Lapisan HOST. INVARIANT: tak boleh menyebut "USDC", "EURC", "Permit2",
 * "chain", atau "gas" di UI — Host buta primitif, user melihat uang saja
 * (CLAUDE.md invariant #6 & #7).
 */
const listings = [
  { id: "itm_1", title: "Kamera vintage", price: "€120.00", seller: "Studio Berlin" },
  { id: "itm_2", title: "Kamera vintage", price: "€120.00", seller: "Studio Berlin" },
];

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1>RivoKit — marketplace demo</h1>
      <p>
        Harga selalu dipasang penjual dalam mata uangnya. Pembeli memilih sumber dana
        di checkout.
      </p>

      <ul style={{ listStyle: "none", padding: 0 }}>
        {listings.map((item) => (
          <li
            key={item.id}
            style={{ border: "1px solid #ddd", borderRadius: 8, padding: "1rem", marginBottom: "0.75rem" }}
          >
            <strong>{item.title}</strong>
            <div>{item.price}</div>
            <small>{item.seller}</small>
          </li>
        ))}
      </ul>

      <p style={{ fontSize: 12, opacity: 0.7 }}>
        Leg pembayaran fiat berjalan di <strong>sandbox</strong>.
      </p>
    </main>
  );
}
