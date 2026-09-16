
### SikaLock — USSD Escrow for Informal Trade

One-line pitch:  
A USSD escrow service that lets informal traders safely buy and sell goods across regions without either side having to trust the other upfront.

Problem:  
Informal regional trade creates a classic trust deadlock.

For example, a buyer in another region wants goods from Abossey Okai or Makola:

- The buyer does not want to pay before receiving the goods.
- The seller will not ship goods on a VIP bus without payment.
- Both parties resort to sending cash through drivers or intermediaries.
- Cash transportation creates theft, loss, and fraud risks.

Target users:
- Cross-regional informal traders
- Spare-parts traders
- Market traders
- Hardware sellers
- Wholesale buyers

Solution:  
A simple USSD escrow system.

Transaction flow:
1. Buyer dials the SikaLock USSD code.
2. Buyer selects the seller and amount.
3. Funds are locked in escrow.
4. Seller receives confirmation that payment is secured.
5. Seller ships the goods.
6. Buyer receives the goods.
7. Buyer confirms through USSD.
8. Funds are released to the seller.

MoMo integration:
- MoMo Collection API for receiving funds.
- MoMo Disbursement API for releasing funds.

Why USSD:  
The product is designed for the offline economy and does not require:
- Smartphones
- Banking apps
- Complex onboarding
- Reliable mobile data

MVP:
- USSD menu.
- Escrow transaction ledger.
- Lock/status/release flows.
- MoMo sandbox integration.
- Mock delivery confirmation.

Business model:  
Approximately 1% transaction fee.

Competitive advantage:  
Instead of replacing existing informal trade behavior, SikaLock adds a trust layer to behavior that already exists.

Expansion:
- Bus-based delivery
- Supplier marketplaces
- Wholesale transactions
- Cross-border West African trade

Main risk:  
Dispute resolution. If a buyer claims that goods were damaged, incomplete, or never received, SikaLock needs a reliable dispute-resolution mechanism.

MoMo advantage: High
