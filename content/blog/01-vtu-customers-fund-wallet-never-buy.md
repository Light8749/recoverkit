---
title: Why VTU customers fund their wallet and never buy (and how to win them back)
slug: vtu-customers-fund-wallet-never-buy
description: A wallet deposit isn't a sale. Here's why VTU customers top up and disappear, how to find them in your data, and how to follow up without spamming.
---
If someone funds their wallet on your VTU site and never buys airtime or data, they haven't become a customer yet. They've shown strong interest, and that's the best time to follow up. Most VTU businesses count the deposit as revenue and move on, which hides the problem.

## A deposit is not a purchase

On a VTU, betting or fintech app, money arrives in two steps:

1. The customer **funds their wallet** through Paystack, Flutterwave, Monnify or a bank transfer.
2. Later, they **spend** that balance on airtime, data, cable TV or electricity.

Your payment gateway only sees step 1. If you treat every gateway payment as a sale, a person who deposited ₦2,000 and never bought anything looks exactly like a happy customer. You'll never message them, because your records say they already paid.

The fix is to record the real purchase separately: the moment your vendor API confirms the airtime or data went through. That's the event that means "this person bought".

## Why people fund and then stop

These are the common reasons, and each one points to a different message:

- **The purchase failed.** The vendor API timed out or the network was down, and the customer gave up. They need reassurance that their money is safe and that it works now.
- **They funded "for later".** Some people top up the wallet so it's ready when they need data. A gentle reminder when they'd normally run out works well.
- **The price or plan confused them.** They couldn't find the bundle they wanted, or the price looked different from what they expected. Point them to the exact plan.
- **They were testing you.** A small first deposit is often a trust test. A friendly, human message from the business shows there's someone behind the site.

## How to find these people in your data

You're looking for customers where:

- there is at least one **wallet funding** record, and
- there are **no purchase** records after it, and
- some days have passed since the deposit, usually two to seven.

In SQL that's a "deposits without purchases" query. If your wallet and orders live in different tables, join them on the customer ID. Be careful with refunds and reversals: only count successful purchases.

RecoverKit does this automatically. Set your gateway mode to **wallet deposits**, and only purchases your server reports with `trackPurchase` count as sales. Everyone who funded and never bought shows up under **Funded wallet, never bought**.

## What to send them

Keep it short, personal and useful. One message is usually enough. A good follow-up:

- uses their first name
- mentions the balance is still there
- removes the likely obstacle (a link straight to data plans, or a note that a failed purchase was refunded to the wallet)
- has no pressure, fake countdowns or ALL CAPS

For example:

> Hi Ada, your ₦2,000 is still in your wallet o. If you were trying to buy data, the MTN and Airtel plans are working fine now. Tap here to finish in seconds.

WhatsApp usually gets read fastest in Nigeria, with SMS as a backup for people who don't use WhatsApp. Email works best for bigger purchases and B2B customers.

## Don't message people who already bought

The worst follow-up is the one sent to someone who bought yesterday. Before any message goes out, check again that the person:

- hasn't made a purchase since you drafted the message
- hasn't opted out
- hasn't been messaged in the last week

## The short version

A wallet deposit is a signal, not a sale. Record real purchases separately, look for people who funded and stopped, and send one helpful, human message. That's often the cheapest revenue a VTU business can find, because these customers already trusted you with their money.
