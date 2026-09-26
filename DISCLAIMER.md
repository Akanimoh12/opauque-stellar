# Disclaimer

## Experimental Software

Opaque is **experimental, unaudited software** provided on an "as-is" basis. It has **not** undergone a formal security audit. Use it at your own risk.

## No Guarantees of Privacy

While the protocol is designed to provide unlinkable receive addresses and selective disclosure of reputation, **no privacy system is perfect**. Specific risks include:

- **Metadata leakage.** On-chain transactions carry timing, amount, and fee-payer information that sophisticated observers may use for statistical linkage analysis.
- **Local data loss.** Ghost addresses rely on local device storage. Lost data may make funds **permanently inaccessible** with no on-chain recovery. See the [User Key Management Guide](docs/KEY_MANAGEMENT_GUIDE.md#backup-practices) for what to back up and how payment-link vs manual ghost receives differ.
- **Scanner limitations.** The WASM scanner depends on complete announcement data from RPC or Horizon. Missed events may delay detection until a rescan.
- **View-tag false positives.** Roughly 1 in 256 announcements pass the view-tag filter without being yours, requiring full derivation to confirm.

## Cryptographic Assumptions

Security relies on:

- **ECDLP hardness** on secp256k1.
- **Groth16 soundness** on BN254 with a trusted setup (development artifacts in-repo are not production-ready).
- **Keccak-256** and **Poseidon** collision resistance.

## Smart Contract Risks

Soroban contracts deployed on Stellar testnet have **not been formally verified**. Risks include logic bugs, admin-controlled Merkle roots, growing nullifier state, and upgrade authority if contracts are not immutable.

## Not Financial Advice

Nothing here is financial, legal, or tax advice. Comply with applicable laws in your jurisdiction.

## Regulatory and Sanctions Compliance

Opaque is a privacy tool, **not** a tool for evading the law. It is not intended to facilitate money laundering, sanctions evasion, or any other illicit activity, and the maintainers do not operate a custodial or money-transmission service. You are solely responsible for ensuring your use complies with the laws and sanctions regimes that apply to you. Suspected abuse can be reported through the channel described in [SECURITY.md](SECURITY.md).

## Testnet Default

Default configuration targets **Stellar testnet**. Test XLM has no monetary value. Do not send mainnet funds.

## No Warranty

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

By using this software, you acknowledge that you have read, understood, and accepted the risks described above.

_Last reviewed: 2026-06-20._
