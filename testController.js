require("dotenv").config();
const { getUserProfile } = require("c:/Users/user2/Desktop/test/cocpit-backend/src/modules/user/user.controller.js");

async function testController() {
  const req = {
    params: { id: "swaroopmanade21" },
    user: { sub: "00000000-0000-0000-0000-000000000000" }, // valid uuid format
    headers: {}
  };

  const res = {
    status: (code) => {
      console.log("Status:", code);
      return res;
    },
    json: (data) => {
      console.log("Data:", JSON.stringify(data, null, 2));
    }
  };

  try {
    await getUserProfile(req, res);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

testController();
