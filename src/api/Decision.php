<?php

namespace think\ai\api;

use think\ai\Api;

class Decision extends Api
{
    public function evaluate($params)
    {
        return $this->request('POST', 'decisions', [
            'json' => $params,
        ]);
    }
}
